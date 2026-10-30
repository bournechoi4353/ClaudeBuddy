'use strict';
// APP PATCH (ClaudeBuddy): this is the package's worker.js with one change, marked below. On macOS arm64
// node-llama-cpp ships only a Metal prebuilt binary, so the original getLlama({ gpu: false }) fails there with
// NoBinaryFoundError. PET_BRAIN_GPU now picks the mode:
//   'cpu'   (default) CPU inference. On Apple Silicon it uses the Metal binary with zero GPU layers; elsewhere gpu:false
//           (Intel Macs, Windows and Linux ship CPU-only binaries).
//   'metal' Metal binary with the library's default GPU offload (macOS arm64 only).
// Worker threads copy process.env when they start, so the model service sets PET_BRAIN_GPU before spawning one.
//
// Worker thread: loads the GGUF with node-llama-cpp (CPU) and writes lines. Runs off the main thread.
// Protocol (parent to worker): { type: 'generate', id, prompt } | { type: 'abort', id }
// Worker to parent: { type: 'ready' } | { type: 'init-error', message }
//   | { type: 'result', id, text, stopReason, bannedStop } | { type: 'gen-error', id, message }
//   stopReason is 'eogToken' (finished), 'maxTokens' (cut off), 'abort' or 'stopGenerationTrigger'.
//   bannedStop is true when generation was stopped because a banned word appeared in the text.
const { parentPort, workerData } = require('node:worker_threads');
const { prefixText } = require('./linePrompt.js');
const { banned_substrings: BANNED } = require('./banned.json');

const { modelPath, threads, maxTokens = 28, temperature = 0.7 } = workerData;
let model;
let completion;
let tokenBias;
let sequence;
let prefixTokens;
const aborts = new Map();

// Forbid (1) every vocabulary token that contains a non-ASCII character (lines must be plain ASCII), and
// (2) every token that contains a banned word (letters only, 4+ characters). (1) is complete. (2) is partial:
// a word spelled with several tokens can still appear, so run() also stops generation when the text contains one.
function buildTokenBias(TokenBias) {
  const words = BANNED.filter((b) => /^[a-z]{4,}$/.test(b));
  const bias = new TokenBias(model.tokenizer);
  for (const token of model.iterateAllTokens()) {
    let text;
    try { text = model.detokenize([token]).toLowerCase(); } catch (err) { continue; }
    // eslint-disable-next-line no-control-regex
    if (/[^\x00-\x7f]/.test(text) || (text.length >= 4 && words.some((w) => text.includes(w)))) bias.set(token, 'never');
  }
  return bias;
}

async function init() {
  const { getLlama, LlamaCompletion, TokenBias } = await import('node-llama-cpp');
  // APP PATCH: see the header. Original: getLlama({ gpu: false, logLevel: 'error' }) and loadModel({ modelPath }).
  const gpuMode = process.env.PET_BRAIN_GPU === 'metal' ? 'metal' : 'cpu';
  const cpuOnMac = gpuMode === 'cpu' && process.platform === 'darwin' && process.arch === 'arm64';
  const llama = await getLlama({ gpu: gpuMode === 'metal' || cpuOnMac ? 'metal' : false, logLevel: 'error' });
  model = await llama.loadModel({ modelPath, ...(cpuOnMac ? { gpuLayers: 0 } : {}) });
  const context = await model.createContext({ sequences: 1, contextSize: 512, ...(threads ? { threads } : {}) });
  sequence = context.getSequence();
  completion = new LlamaCompletion({ contextSequence: sequence });
  tokenBias = buildTokenBias(TokenBias);
  // Warm up: first call compiles kernels and touches the weights.
  await run('<|im_start|>system\nHi<|im_end|>\n<|im_start|>user\nhello<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n', undefined, 4);
  prefixTokens = model.tokenize(prefixText(), true);
  await primePrefix();
}

// Prefix reuse: every prompt starts with the same system turn. Qwen3.5 is a hybrid model, so the library cannot rewind its
// state by itself; a checkpoint taken right after the system turn lets each request evaluate only what follows it.
async function primePrefix() {
  await sequence.clearHistory();
  await sequence.evaluateWithoutGeneratingNewTokens(prefixTokens);
  await sequence.takeCheckpoint();
}

async function run(prompt, signal, limit = maxTokens) {
  if (prefixTokens && sequence.nextTokenIndex < prefixTokens.length) await primePrefix();
  const tokens = model.tokenize(prompt, true); // true: parse the ChatML special tokens
  // Stop the moment the text contains a banned word, so the parent can resample instead of waiting for a bad line to finish.
  const inner = new AbortController();
  if (signal) signal.addEventListener('abort', () => inner.abort(), { once: true });
  let soFar = '';
  let bannedStop = false;
  const res = await completion.generateCompletionWithMeta(tokens, {
    maxTokens: limit, temperature, topK: 40, topP: 0.9, seed: Math.floor(Math.random() * 2147483647),
    signal: inner.signal, stopOnAbortSignal: true, trimWhitespaceSuffix: true, disableContextShift: true, tokenBias,
    onTextChunk: (chunk) => {
      soFar += chunk;
      const low = soFar.toLowerCase();
      if (!bannedStop && BANNED.some((b) => low.includes(b))) { bannedStop = true; inner.abort(); }
    },
  });
  return { text: res.response, stopReason: res.metadata.stopReason, bannedStop };
}

parentPort.on('message', async (m) => {
  if (m.type === 'abort') { const c = aborts.get(m.id); if (c) c.abort(); return; }
  if (m.type !== 'generate') return;
  const controller = new AbortController();
  aborts.set(m.id, controller);
  try {
    const out = await run(m.prompt, controller.signal);
    parentPort.postMessage({ type: 'result', id: m.id, ...out });
  } catch (err) {
    parentPort.postMessage({ type: 'gen-error', id: m.id, message: String((err && err.message) || err) });
  } finally {
    aborts.delete(m.id);
  }
});

init().then(() => parentPort.postMessage({ type: 'ready' }))
  .catch((err) => parentPort.postMessage({ type: 'init-error', message: String((err && err.message) || err) }));
