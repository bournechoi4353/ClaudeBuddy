// Hands-free wake word (renderer). Always-on, energy-gated VAD captures each
// spoken utterance; we transcribe it locally via the Moonshine worker (the same
// stt:transcribe IPC push-to-talk uses) and fuzzy-match the wake name "clawd"
// (or "claude" / "hey clawd"). Only the command AFTER the name is sent on.
//
// Ported from C.V.A (src/renderer/src/wake.ts + src/shared/wake-detect.mjs),
// retuned for "clawd" and inlined as a classic <script> (the renderer has no
// bundler, so no ESM import). Wrapped in an IIFE; exposed as window.ClawdWake.
//
// Off by default; started only when the user enables Hands-free in the tray.

(function () {
  // ---------- wake-phrase matching ----------
  const GREETINGS = new Set(['hey', 'hay', 'hi', 'he', 'a', 'ay', 'aye', 'eh', 'ey', 'yo', 'ok', 'okay', 'oi']);
  const FILLERS = new Set([...GREETINGS, 'um', 'uh', 'so', 'well', 'and', 'oh', 'now']);
  // Moonshine renderings of "clawd"/"claude", in two tiers:
  // STRONG — unambiguously the name; these can wake him ALONE ("clawd.").
  // WEAK — common English words the model substitutes for the name; these wake
  // him only WITH a command attached ("cloud, what's the weather"), so ambient
  // speech can't constantly arm the "listening…" state.
  const STRONG_VARIANTS = new Set([
    'clawd', 'clawed', 'clod', 'klawd', 'klaud',
    'claude', 'claud', 'klaude', 'clode', 'clawde',
  ]);
  const WEAK_VARIANTS = new Set(['cloud', 'clause', 'called', 'clad', 'claw', 'quad']);
  // Common words within edit distance 2 of the name — never treat as it.
  const STOPWORDS = new Set(['could', 'would', 'should', 'cold', 'call', 'old', 'loud', 'allowed', 'aloud', 'glad', 'clap']);

  function levenshtein(a, b) {
    if (a === b) return 0;
    let prev = new Array(b.length + 1);
    let cur = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      cur[0] = i;
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      const t = prev; prev = cur; cur = t;
    }
    return prev[b.length];
  }

  // Classify a word as the name: 'strong' (can wake alone), 'weak' (needs a
  // command attached), or null. The fuzzy net is wider than before (distance 2
  // counts as weak) so off-pronunciations still work when a command follows.
  function nameStrength(word) {
    if (STRONG_VARIANTS.has(word)) return 'strong';
    if (STOPWORDS.has(word)) return null;
    if (WEAK_VARIANTS.has(word)) return 'weak';
    if (word.length >= 4 && word.length <= 8) {
      const d = Math.min(levenshtein(word, 'clawd'), levenshtein(word, 'claude'));
      if (d <= 1) return 'strong';
      if (d === 2) return 'weak';
    }
    return null;
  }

  function normalize(text) {
    return text.toLowerCase().replace(/[^a-z0-9\s']/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function detectWake(text) {
    const tokens = normalize(text).split(' ').filter(Boolean);
    let i = 0;
    while (i < tokens.length && FILLERS.has(tokens[i])) i++;
    if (i < tokens.length) {
      const s = nameStrength(tokens[i]);
      if (s) return { woke: true, strength: s, word: tokens[i], command: tokens.slice(i + 1).join(' ') };
    }
    for (let j = 0; j < tokens.length - 1; j++) {
      if (GREETINGS.has(tokens[j])) {
        const s = nameStrength(tokens[j + 1]);
        if (s) return { woke: true, strength: s, word: tokens[j + 1], command: tokens.slice(j + 2).join(' ') };
      }
    }
    return { woke: false, strength: null, word: '', command: '' };
  }

  const NOISE_OUT = new Set([
    'you', 'thank you', 'thanks', 'thanks for watching', 'thank you for watching',
    'bye', 'bye bye', 'the end', 'so', 'see you', 'please subscribe', 'subscribe',
    'okay', 'ok', 'yeah', 'uh', 'um', 'hmm', 'huh', 'oh', 'mm', 'mmm',
    'all right', 'alright', 'music', 'applause', 'laughter', 'silence',
  ]);
  function looksLikeNoise(text) {
    const t = text.toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
    return t.length < 2 || NOISE_OUT.has(t);
  }

  // ---------- VAD capture ----------
  const SAMPLE_RATE = 16000;
  const BUFFER = 2048; // ~128ms frames
  const FRAME_MS = (BUFFER / SAMPLE_RATE) * 1000;
  // ~0.7s of silence ends an utterance — 0.5s chopped commands at natural
  // mid-sentence pauses ("clawd, ... what's the weather"), a top finickiness cause.
  const HANG_FRAMES = Math.round(700 / FRAME_MS);
  const MIN_SPEECH_FRAMES = Math.round(250 / FRAME_MS);
  const MAX_FRAMES = Math.round(10000 / FRAME_MS);
  // ~768ms of pre-roll so the onset of "clawd" isn't clipped — a clipped name
  // transcribes as "awd"/"lawd" and fails the wake match.
  const PREROLL_FRAMES = 6;
  // Onset lowered (2.2 → 1.8, abs 0.008 → 0.006) so quieter / farther speech
  // still triggers capture; the noise filter downstream catches false starts.
  const ABS_MIN = 0.006, ONSET_MULT = 1.8, RELEASE_MULT = 1.4, NOISE_CAP = 0.04;

  let stream = null, ctx = null, source = null, processor = null;
  let running = false;
  let paused = false; // suspended while Clawd is speaking / a turn is in flight / mic-button capture
  let followUntil = 0; // after a bare "clawd", next utterance is taken as the command directly

  let speaking = false, silence = 0, speech = 0, frames = [], preroll = [], noiseFloor = 0.012;

  function concat(fs) {
    let len = 0; for (const f of fs) len += f.length;
    const out = new Float32Array(len);
    let o = 0; for (const f of fs) { out.set(f, o); o += f.length; }
    return out;
  }

  // A short two-tone "I'm listening" chime.
  function chime() {
    try {
      const c = new AudioContext();
      const now = c.currentTime;
      [660, 990].forEach((freq, i) => {
        const osc = c.createOscillator(), gain = c.createGain();
        osc.type = 'sine'; osc.frequency.value = freq;
        osc.connect(gain); gain.connect(c.destination);
        const t = now + i * 0.1;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.15, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
        osc.start(t); osc.stop(t + 0.17);
      });
      setTimeout(() => c.close().catch(() => {}), 500);
    } catch (_) {}
  }

  // Hard gate — situations where the mic data itself is unusable: hands-free
  // disabled mid-flight, or the push-to-talk mic button owns the mic. NOTE:
  // Clawd speaking / a busy turn are NOT gated here anymore — being silently
  // deaf in those windows was the main "he didn't hear me" complaint. Those
  // cases are handled per-utterance below (barge-in / honest feedback).
  function shouldIgnoreCapture() {
    if (paused) return true;
    if (window.ClawdMic && window.ClawdMic.isCapturing && window.ClawdMic.isCapturing()) return true;
    return false;
  }

  let lastBareWakeAt = 0;
  let lastHeardBubbleAt = 0;

  async function handleUtterance(audio) {
    if (shouldIgnoreCapture()) return;
    let text = '';
    try {
      const r = await window.crabAPI.transcribe(audio);
      text = (r && r.text ? r.text : '').trim();
    } catch (_) { return; }
    if (!text || looksLikeNoise(text)) return;

    const now = performance.now();
    const busy = !!(window.Chat && window.Chat.isBusy && window.Chat.isBusy());
    const talking = !!(window.ClawdVoice && window.ClawdVoice.isSpeaking && window.ClawdVoice.isSpeaking());

    // In a follow-up window: the whole utterance is the command (no wake needed).
    if (now < followUntil && !busy) {
      followUntil = 0;
      submitCommand(text);
      return;
    }
    const { woke, strength, word, command } = detectWake(text);
    if (!woke) return;

    // Barge-in: saying his name while he's talking cuts the audio off.
    if (talking && window.ClawdVoice && window.ClawdVoice.stop) window.ClawdVoice.stop();
    if (busy) {
      // A turn is still in flight — be honest instead of silently deaf.
      if (window.Crab && window.Crab.think) window.Crab.think('one sec — still on the last thing', 2500);
      return;
    }

    if (command && command.length >= 2) {
      // Name + command — accept at either strength (a weak variant with a real
      // command is strong evidence the user meant him).
      if (window.Crab && window.Crab.noteInteraction) window.Crab.noteInteraction();
      if (window.Crab && window.Crab.wakePerk) window.Crab.wakePerk();
      submitCommand(command);
      return;
    }

    // Bare name. Already listening → just extend the window quietly (no
    // re-chime, no re-bubble — this was the "constantly says listening" spam).
    if (now < followUntil) {
      followUntil = now + 8000;
      return;
    }
    // Only an unambiguous (strong) name arms listening, and not more than once
    // per 10s — weak variants are common words ambient speech kept tripping.
    if (strength !== 'strong') {
      // Diagnostic so failed wakes aren't silent: show what he heard.
      if (now - lastHeardBubbleAt > 30_000 && window.Crab && window.Crab.think) {
        lastHeardBubbleAt = now;
        window.Crab.think(`heard "${word}" — say "clawd"?`, 3500);
      }
      return;
    }
    if (now - lastBareWakeAt < 10_000) return;
    lastBareWakeAt = now;
    if (window.Crab && window.Crab.noteInteraction) window.Crab.noteInteraction();
    if (window.Crab && window.Crab.wakePerk) window.Crab.wakePerk();
    chime();
    followUntil = now + 8000;
    if (window.Crab && window.Crab.think) window.Crab.think('listening…', 8000);
  }

  function submitCommand(text) {
    if (window.Chat && window.Chat.submit) window.Chat.submit(text, { voice: true });
  }

  async function start() {
    if (running) return;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (_) {
      if (window.Chat && window.Chat.systemNote) {
        window.Chat.systemNote("i can't hear — allow microphone access in System Settings → Privacy → Microphone.");
      }
      return false;
    }
    ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    source = ctx.createMediaStreamSource(stream);
    processor = ctx.createScriptProcessor(BUFFER, 1, 1);
    speaking = false; silence = 0; speech = 0; frames = []; preroll = []; noiseFloor = 0.012;
    running = true;

    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const frame = new Float32Array(input);
      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
      const rms = Math.sqrt(sum / input.length);

      preroll.push(frame);
      if (preroll.length > PREROLL_FRAMES) preroll.shift();

      const onset = Math.max(ABS_MIN, noiseFloor * ONSET_MULT);
      const release = Math.max(ABS_MIN * 0.8, noiseFloor * RELEASE_MULT);

      if (!speaking) {
        const k = rms < noiseFloor ? 0.25 : 0.02;
        noiseFloor = Math.min(noiseFloor + (rms - noiseFloor) * k, NOISE_CAP);
        if (rms > onset && !shouldIgnoreCapture()) {
          speaking = true; frames = [...preroll]; speech = 1; silence = 0;
        }
      } else {
        frames.push(frame);
        if (rms > release) { silence = 0; speech++; }
        else silence++;
        if (silence >= HANG_FRAMES || frames.length >= MAX_FRAMES) {
          const enough = speech >= MIN_SPEECH_FRAMES;
          const audio = enough ? concat(frames) : null;
          speaking = false; silence = 0; speech = 0; frames = [];
          if (audio) handleUtterance(audio);
        }
      }
    };

    source.connect(processor);
    processor.connect(ctx.destination);
    return true;
  }

  function stop() {
    running = false;
    try { processor && processor.disconnect(); source && source.disconnect(); } catch (_) {}
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (ctx) ctx.close().catch(() => {});
    processor = null; source = null; ctx = null; stream = null;
    frames = []; preroll = []; followUntil = 0;
  }

  window.ClawdWake = {
    start,
    stop,
    isRunning: () => running,
    pause: () => { paused = true; },
    resume: () => { paused = false; },
  };

  // Main toggles hands-free on/off.
  if (window.crabAPI && window.crabAPI.onHandsFree) {
    window.crabAPI.onHandsFree((info) => {
      if (info && info.on) start();
      else stop();
    });
  }
})();
