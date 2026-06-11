// Microphone capture for push-to-talk (renderer). Ported from C.V.A audio.ts.
// Captures raw mono 16kHz Float32 PCM straight from a 16kHz AudioContext, so on
// stop the audio is already exactly what Moonshine wants — transcription starts
// instantly. While capturing, feeds amplitude to the crab so he visibly listens.
//
// Wrapped in an IIFE + exposed as window.ClawdMic to avoid colliding with crab.js /
// chat.js in the shared renderer global scope (the renderer-script-globals gotcha).

(function () {
  const SAMPLE_RATE = 16000;
  const BUFFER = 2048; // ~128ms frames
  const MAX_MS = 12000; // safety auto-stop so the mic never stays hot

  let stream = null;
  let ctx = null;
  let source = null;
  let processor = null;
  let frames = [];
  let capturing = false;
  let autoStopTimer = 0;

  function setLevel(level) {
    if (window.Crab && window.Crab.setSpeakingLevel) window.Crab.setSpeakingLevel(level);
  }

  // Push mic state to the chat panel so the mic button reflects it.
  // 'recording' | 'transcribing' | 'idle'.
  function emitState(s) {
    if (window.Chat && window.Chat.setMicState) window.Chat.setMicState(s);
  }

  async function start() {
    if (capturing) return;
    let s;
    try {
      s = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      // Permission denied / no device — tell the user in the chat bubble.
      if (window.Chat && window.Chat.systemNote) {
        window.Chat.systemNote("i can't hear — allow microphone access in System Settings → Privacy → Microphone.");
      }
      emitState('idle');
      return;
    }
    stream = s;
    ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    source = ctx.createMediaStreamSource(stream);
    processor = ctx.createScriptProcessor(BUFFER, 1, 1);
    frames = [];
    capturing = true;

    if (window.Crab && window.Crab.setListening) window.Crab.setListening(true);

    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      frames.push(new Float32Array(input));
      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
      setLevel(Math.min(1, Math.sqrt(sum / input.length) * 3));
    };

    source.connect(processor);
    processor.connect(ctx.destination); // ScriptProcessor only fires when connected
    emitState('recording');

    autoStopTimer = setTimeout(() => stopAndTranscribe(), MAX_MS);
  }

  function teardown() {
    try { processor && processor.disconnect(); source && source.disconnect(); } catch (_) {}
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (ctx) ctx.close().catch(() => {});
    processor = null; source = null; ctx = null; stream = null;
    capturing = false;
    setLevel(0);
    if (window.Crab && window.Crab.setListening) window.Crab.setListening(false);
  }

  function collect() {
    let len = 0;
    for (const f of frames) len += f.length;
    const out = new Float32Array(len);
    let o = 0;
    for (const f of frames) { out.set(f, o); o += f.length; }
    frames = [];
    return out;
  }

  async function stopAndTranscribe() {
    if (!capturing) return;
    clearTimeout(autoStopTimer);
    const samples = collect();
    teardown();
    emitState('transcribing');

    if (!samples.length || !window.crabAPI || !window.crabAPI.transcribe) { emitState('idle'); return; }
    let text = '';
    try {
      const r = await window.crabAPI.transcribe(samples);
      if (r && r.error) {
        if (window.Chat && window.Chat.systemNote) window.Chat.systemNote("i couldn't make that out. try again?");
      }
      text = (r && r.text ? r.text : '').trim();
    } catch (_) {
      emitState('idle');
      return;
    }
    emitState('idle');
    // Drop empty / obvious non-speech.
    if (!text || text.length < 2) return;
    if (window.Chat && window.Chat.submit) window.Chat.submit(text);
  }

  window.ClawdMic = {
    start,
    stop: stopAndTranscribe,
    isCapturing: () => capturing,
  };
})();
