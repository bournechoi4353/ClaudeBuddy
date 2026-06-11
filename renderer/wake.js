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
  // Whisper/Moonshine renderings of "clawd"/"claude".
  const VARIANTS = new Set([
    'clawd', 'clawed', 'clod', 'cloud', 'klawd', 'klaud',
    'claude', 'claud', 'klaude', 'clode', 'clause',
  ]);

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

  function wakeish(word) {
    if (VARIANTS.has(word)) return true;
    if (word.length >= 4 && word.length <= 7) {
      return levenshtein(word, 'clawd') <= 1 || levenshtein(word, 'claude') <= 1;
    }
    return false;
  }

  function normalize(text) {
    return text.toLowerCase().replace(/[^a-z0-9\s']/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function detectWake(text) {
    const tokens = normalize(text).split(' ').filter(Boolean);
    let i = 0;
    while (i < tokens.length && FILLERS.has(tokens[i])) i++;
    if (i < tokens.length && wakeish(tokens[i])) {
      return { woke: true, command: tokens.slice(i + 1).join(' ') };
    }
    for (let j = 0; j < tokens.length - 1; j++) {
      if (GREETINGS.has(tokens[j]) && wakeish(tokens[j + 1])) {
        return { woke: true, command: tokens.slice(j + 2).join(' ') };
      }
    }
    return { woke: false, command: '' };
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
  const HANG_FRAMES = Math.round(500 / FRAME_MS); // ~0.5s silence ends an utterance
  const MIN_SPEECH_FRAMES = Math.round(250 / FRAME_MS);
  const MAX_FRAMES = Math.round(10000 / FRAME_MS);
  const PREROLL_FRAMES = 4;
  const ABS_MIN = 0.008, ONSET_MULT = 2.2, RELEASE_MULT = 1.4, NOISE_CAP = 0.04;

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

  // Should we ignore captured speech right now? (Clawd talking → echo; a turn in
  // flight; the push-to-talk mic button is using the mic.)
  function shouldIgnore() {
    if (paused) return true;
    if (window.ClawdVoice && window.ClawdVoice.isSpeaking && window.ClawdVoice.isSpeaking()) return true;
    if (window.Chat && window.Chat.isBusy && window.Chat.isBusy()) return true;
    if (window.ClawdMic && window.ClawdMic.isCapturing && window.ClawdMic.isCapturing()) return true;
    return false;
  }

  async function handleUtterance(audio) {
    if (shouldIgnore()) return;
    let text = '';
    try {
      const r = await window.crabAPI.transcribe(audio);
      text = (r && r.text ? r.text : '').trim();
    } catch (_) { return; }
    if (!text || looksLikeNoise(text)) return;

    const now = performance.now();
    // In a follow-up window: the whole utterance is the command (no wake needed).
    if (now < followUntil) {
      followUntil = 0;
      submitCommand(text);
      return;
    }
    const { woke, command } = detectWake(text);
    if (!woke) return;
    // Woke up — perk the crab up.
    if (window.Crab && window.Crab.noteInteraction) window.Crab.noteInteraction();
    if (window.Crab && window.Crab.wakePerk) window.Crab.wakePerk();
    if (command && command.length >= 2) {
      submitCommand(command);
    } else {
      // Bare "clawd" — chime and arm an ~8s window for the command.
      chime();
      followUntil = now + 8000;
      if (window.Chat && window.Chat.systemNote) window.Chat.systemNote('listening…');
    }
  }

  function submitCommand(text) {
    if (window.Chat && window.Chat.submit) window.Chat.submit(text);
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
        if (rms > onset && !shouldIgnore()) {
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
