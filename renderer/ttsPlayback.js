// Gapless audio queue for Clawd's voice. Per-sentence audio chunks arrive over IPC
// as Int16 PCM; we play them back-to-back via Web Audio and drive the crab's
// "speaking" bob from the live output amplitude so he mouths along to his own voice.
// Ported from C.V.A (src/renderer/src/ttsPlayback.ts).
//
// Shares the page's global scope with crab.js / chat.js — everything here is wrapped
// in an IIFE and exposed as window.ClawdVoice to avoid top-level name collisions
// (see the renderer-script-globals gotcha).

(function () {
  let queue = [];
  let playing = false;
  let ctx = null;
  let activeSource = null;
  let raf = 0;

  function setSpeakingLevel(level) {
    if (window.Crab && window.Crab.setSpeakingLevel) window.Crab.setSpeakingLevel(level);
  }

  function warm() {
    if (!ctx) ctx = new AudioContext();
    ctx.resume().catch(() => {});
  }

  function enqueue(samples, rate) {
    queue.push({ samples, rate });
    if (!playing) playNext();
  }

  function playNext() {
    const chunk = queue.shift();
    if (!chunk) {
      playing = false;
      setSpeakingLevel(0);
      if (window.Crab && window.Crab.setSpeaking) window.Crab.setSpeaking(false);
      return;
    }
    playing = true;
    if (window.Crab && window.Crab.setSpeaking) window.Crab.setSpeaking(true);

    if (!ctx) ctx = new AudioContext();
    const audioCtx = ctx;

    const buffer = audioCtx.createBuffer(1, chunk.samples.length, chunk.rate);
    const ch = buffer.getChannelData(0);
    for (let i = 0; i < chunk.samples.length; i++) ch[i] = chunk.samples[i] / 0x8000;

    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    activeSource = source;

    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    analyser.connect(audioCtx.destination);

    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      setSpeakingLevel(Math.min(1, Math.sqrt(sum / data.length) * 3));
      raf = requestAnimationFrame(tick);
    };

    source.onended = () => {
      cancelAnimationFrame(raf);
      if (activeSource === source) activeSource = null;
      playNext();
    };

    audioCtx.resume().finally(() => {
      source.start();
      tick();
    });
  }

  function stop() {
    queue = [];
    cancelAnimationFrame(raf);
    try {
      activeSource && activeSource.stop();
    } catch (_) {
      /* already stopped */
    }
    activeSource = null;
    playing = false;
    setSpeakingLevel(0);
    if (window.Crab && window.Crab.setSpeaking) window.Crab.setSpeaking(false);
  }

  window.ClawdVoice = { warm, enqueue, stop, isSpeaking: () => playing };

  // Wire IPC: per-sentence audio in, plus a stop signal on new turns / barge-in.
  if (window.crabAPI) {
    window.crabAPI.onTtsAudio &&
      window.crabAPI.onTtsAudio((info) => {
        if (!info || !info.samples) return;
        // IPC delivers Int16Array (structured clone preserves the type).
        enqueue(info.samples, info.rate);
      });
    window.crabAPI.onTtsStop && window.crabAPI.onTtsStop(() => stop());
    // Pre-create the AudioContext so the first reply doesn't pay for it.
    warm();
  }
})();
