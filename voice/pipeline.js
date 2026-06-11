// Streaming speech pipeline — ported from C.V.A (src/main/pipeline.ts) to CommonJS
// and adapted to Clawd's push model (main.js feeds it chunk text as the agent
// streams). As text arrives we split it into sentences the moment each completes,
// synthesize that sentence with Kokoro, and emit the audio — so sentence 1 plays
// while Claude is still writing sentence 2. Before the first sentence completes we
// speak its opening clause (cut at a comma) so a long first sentence can't delay audio.

const tts = require('./tts');

// Make a sentence safe to speak: markdown links → their text, bare URLs / markdown
// artifacts dropped. Returns '' if nothing speakable remains.
function speakable(s) {
  return s
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [text](url) → text
    .replace(/https?:\/\/\S+/g, '') // bare URLs
    .replace(/[*_`#>]/g, '') // stray markdown
    .replace(/\s+/g, ' ')
    .trim();
}

// Pull complete sentences out of a growing buffer. A boundary is .!? followed by
// whitespace (so "3.5" and mid-stream dots don't split). On force, flush the rest.
function takeSentences(buffer, force) {
  const sentences = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i++) {
    const c = buffer[i];
    if (c !== '.' && c !== '!' && c !== '?') continue;
    let j = i;
    while (j + 1 < buffer.length && '.!?'.includes(buffer[j + 1])) j++;
    const next = buffer[j + 1];
    if (next === undefined) break; // punctuation at end — wait for more
    if (/\s/.test(next)) {
      const s = buffer.slice(start, j + 1).trim();
      if (s) sentences.push(s);
      start = j + 1;
    }
    i = j;
  }
  let rest = buffer.slice(start);
  if (force && rest.trim()) {
    sentences.push(rest.trim());
    rest = '';
  }
  return { sentences, rest };
}

// Naturalness vs latency: synthesizing each sentence (or clause) separately makes
// Kokoro reset its prosody contour at every seam — that's the "robotic in the
// middle" feel. Clawd's replies are short (1–2 sentences), so we DON'T stream
// sub-units: we hold the whole reply and synthesize it in ONE generate() call,
// giving Kokoro a single natural contour. Only if a reply runs long do we start
// flushing — and then only at whole-SENTENCE boundaries, never mid-sentence.
const LONG_REPLY_CHARS = 220;

// Creates a speaker for one turn. `send(channel, payload)` ships audio to the
// renderer; `shouldCancel()` lets a new turn / barge-in stop synthesis.
function createSpeaker(send, shouldCancel) {
  let buffer = '';
  let seq = 0;
  let started = false; // have we flushed any sentence yet (long-reply path)?
  let synthChain = Promise.resolve();

  const emit = (text) => {
    const spoken = speakable(text);
    if (!spoken) return;
    const mySeq = seq++;
    synthChain = synthChain.then(async () => {
      if (shouldCancel()) return;
      try {
        const { samples, rate } = await tts.synthesize(spoken);
        if (shouldCancel()) return;
        send('clawd-tts-audio', { seq: mySeq, samples: tts.floatToInt16(samples), rate });
      } catch (err) {
        // TTS failure must never break the (already-displayed) text reply.
        console.error('[voice] synth failed:', err && err.message ? err.message : err);
      }
    });
  };

  return {
    push(delta) {
      buffer += delta;
      // Stay silent until the reply proves "long". Short replies (the common
      // case) never trip this — they're spoken whole in end().
      if (started || buffer.length >= LONG_REPLY_CHARS) {
        const { sentences, rest } = takeSentences(buffer, false);
        if (sentences.length) {
          started = true;
          buffer = rest;
          for (const s of sentences) emit(s);
        }
      }
    },
    async end() {
      // Flush whatever remains. For a short reply this is the ENTIRE thing →
      // one generate() call → one natural contour, no internal seam.
      const tail = buffer.trim();
      if (tail) emit(tail);
      buffer = '';
      await synthChain;
    },
  };
}

module.exports = { createSpeaker };
