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

// Latency vs naturalness: we synthesize per SENTENCE as each one completes in
// the stream, so sentence 1 starts playing while Claude is still writing
// sentence 2 — first audio lands at time-to-first-sentence instead of
// (full reply + full synthesis). Prosody seams only happen at sentence
// boundaries, where a contour reset sounds natural. We never cut mid-sentence
// (the old clause-cut was the "robotic in the middle" culprit).

// Creates a speaker for one turn. `send(channel, payload)` ships audio to the
// renderer; `shouldCancel()` lets a new turn / barge-in stop synthesis.
function createSpeaker(send, shouldCancel) {
  let buffer = '';
  let seq = 0;
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
      const { sentences, rest } = takeSentences(buffer, false);
      if (sentences.length) {
        buffer = rest;
        for (const s of sentences) emit(s);
      }
    },
    async end() {
      const tail = buffer.trim();
      if (tail) emit(tail);
      buffer = '';
      await synthChain;
    },
  };
}

module.exports = { createSpeaker };
