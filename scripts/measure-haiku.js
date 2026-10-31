'use strict';
// Times Claude Haiku on the same synthetic events as scripts/measure-pet-brain.js and scores its lines with
// the same guards, so the local model and Haiku can be compared. Not part of the app and never run by it:
// ambient lines in the app never go to Claude. Run by hand:
//
//   node scripts/measure-haiku.js [--events 96] [--seed 1] [--model claude-haiku-5-5] [--mode both|session|fresh]
//        [--local-json local.json] [--json haiku.json] [--out haiku.md]
//
// Pass the same --events and --seed to `node scripts/measure-pet-brain.js --json local.json` to get the
// same events for the local model, then give that file here as --local-json for a side by side table.
//
// Calls go through the Claude Agent SDK on the user's Claude subscription, exactly as the app's chat does.
// There is no API key path. Two ways of calling are timed:
//   session  one long running query that each event is sent into, like the app's chat session. This is what
//            a Haiku line writer would cost once running. The first call of each session starts the SDK's
//            CLI process and is counted separately.
//   fresh    a new one-shot query per event, so every call also starts the CLI process.
// Haiku is given the same persona and the same signals line the local model gets, as a plain system and
// user message. It is not fine tuned, so this is a zero shot Haiku against a fine tuned 0.8B model.

const fs = require('node:fs');
const path = require('node:path');
const { createPetBrain } = require('../vendor/pet-brain/petBrain.js');
const { userText, SYSTEM_PROMPT } = require('../vendor/pet-brain/linePrompt.js');
const { REACTIONS } = require('../vendor/pet-brain/rules.js');
const { fallbackReason } = require('../pet/reactions.js');
const { seeded, makeEvents, onTopic, sensibleLength, quantile, pct, ms } = require('./measure-pet-brain.js');

// Same environment clean-up as main.js: subscription auth only, no inherited API key or parent session.
delete process.env.ANTHROPIC_API_KEY;
for (const k of Object.keys(process.env)) {
  if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'AI_AGENT') delete process.env[k];
}

const SESSION_LENGTH = 16; // events per session before starting a new one, so history stays short
const BUDGET_MS = 1500;    // the app's per-line timeout for ambient lines (MODEL_CONFIG.timeoutMs)

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

function claudeBinary() {
  const pkg = `claude-agent-sdk-${process.platform}-${process.arch}`;
  const file = path.join(__dirname, '..', 'node_modules', '@anthropic-ai', pkg, process.platform === 'win32' ? 'claude.exe' : 'claude');
  return fs.existsSync(file) ? file : null;
}

// Same shape as the InputStream in agent.js (that file needs Electron, so it is not required here).
class InputStream {
  constructor() { this.queue = []; this.waiters = []; this.closed = false; }
  push(msg) { const w = this.waiters.shift(); if (w) w({ value: msg, done: false }); else this.queue.push(msg); }
  close() { this.closed = true; let w; while ((w = this.waiters.shift())) w({ value: undefined, done: true }); }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const item = this.queue.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function baseOptions(model, binary) {
  const options = {
    systemPrompt: SYSTEM_PROMPT, model, tools: [], settingSources: [], thinking: { type: 'disabled' },
    includePartialMessages: true, maxTurns: 1, permissionMode: 'bypassPermissions',
  };
  if (binary) options.pathToClaudeCodeExecutable = binary;
  return options;
}

const isFirstToken = (msg) => msg.type === 'stream_event' && msg.event && msg.event.type === 'content_block_delta' &&
  msg.event.delta && msg.event.delta.type === 'text_delta';

function finishResult(result, t0, firstTokenMs) {
  if (!result) throw new Error('no result message');
  if (result.is_error || result.subtype !== 'success') throw new Error(`SDK error: ${result.subtype} ${String(result.result || '').slice(0, 200)}`);
  return { text: String(result.result || ''), wallMs: performance.now() - t0, firstTokenMs };
}

/** A new one-shot query. The wall time includes starting the CLI process. */
async function askFresh(sdk, model, binary, text) {
  const t0 = performance.now();
  let firstTokenMs = null;
  let result = null;
  for await (const msg of sdk.query({ prompt: text, options: baseOptions(model, binary) })) {
    if (firstTokenMs === null && isFirstToken(msg)) firstTokenMs = performance.now() - t0;
    if (msg.type === 'result') result = msg;
  }
  return finishResult(result, t0, firstTokenMs);
}

/** One long running query that several questions are sent into, one after another. */
function openSession(sdk, model, binary) {
  const input = new InputStream();
  const q = sdk.query({ prompt: input, options: { ...baseOptions(model, binary), maxTurns: undefined } });
  let turn = null;
  (async () => {
    try {
      for await (const msg of q) {
        if (!turn) continue;
        if (turn.firstTokenMs === null && isFirstToken(msg)) turn.firstTokenMs = performance.now() - turn.t0;
        if (msg.type === 'result') {
          const t = turn; turn = null;
          try { t.resolve(finishResult(msg, t.t0, t.firstTokenMs)); } catch (err) { t.reject(err); }
        }
      }
    } catch (err) {
      if (turn) { const t = turn; turn = null; t.reject(err); }
    }
  })();
  return {
    ask: (text) => new Promise((resolve, reject) => {
      turn = { resolve, reject, t0: performance.now(), firstTokenMs: null };
      input.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
    }),
    close: () => input.close(),
  };
}

const stats = (list) => {
  const s = list.filter((x) => x != null).sort((a, b) => a - b);
  return { n: s.length, p50: quantile(s, 0.5), p95: quantile(s, 0.95), max: s[s.length - 1] ?? null, mean: s.reduce((a, b) => a + b, 0) / (s.length || 1) };
};

/** Runs every event through Haiku in one mode and the real guards. Returns { summary, results }. */
async function run(mode, sdk, model, binary, events) {
  let session = null;
  let inSession = 0;
  const ask = async (text) => {
    if (mode === 'fresh') return { ...(await askFresh(sdk, model, binary, text)), first: true };
    if (!session || inSession >= SESSION_LENGTH) {
      if (session) session.close();
      session = openSession(sdk, model, binary);
      inSession = 0;
    }
    const first = inSession === 0;
    inSession += 1;
    return { ...(await session.ask(text)), first };
  };

  // The wrapper hands petBrain Haiku's answer so the real guards judge it. petBrain's own timeout is set far
  // above any call so a slow answer is still scored for quality; speed against the app's budget is reported separately.
  let current = null;
  let last = null;
  const backend = {
    start: async () => true,
    generate: async () => {
      last = await ask(userText(current.signals, current.reaction));
      return { text: last.text, stopReason: 'eogToken' };
    },
    dispose: async () => {},
  };

  const results = [];
  for (let i = 0; i < events.length; i += 1) {
    const { reaction, signals } = events[i];
    current = { reaction, signals };
    last = null;
    const brain = createPetBrain({ backend, timeoutMs: 120000, cooldownMs: 0 });
    await brain.ready;
    const before = brain.stats();
    const out = await brain.react(signals);
    const accepted = out.source === 'model';
    results.push({
      i, reaction, signals, source: out.source, line: out.line,
      reason: accepted ? null : fallbackReason(before, brain.stats(), null),
      rawText: last ? last.text : null,
      wallMs: last ? last.wallMs : null, firstTokenMs: last ? last.firstTokenMs : null, first: last ? last.first : null,
      guardPass: accepted,
      lengthOk: accepted && sensibleLength(out.line),
      topicOk: accepted && onTopic(out.line, reaction, null),
    });
    if ((i + 1) % 12 === 0) console.error(`  ${mode}: ${i + 1}/${events.length}`);
  }
  if (session) session.close();

  const n = results.length;
  const called = results.filter((r) => r.wallMs != null);
  const warm = mode === 'fresh' ? called.slice(1) : called.filter((r) => !r.first);
  const starts = mode === 'fresh' ? called.slice(0, 1) : called.filter((r) => r.first);
  const guardPass = results.filter((r) => r.guardPass);
  const acceptable = results.filter((r) => r.guardPass && r.lengthOk && r.topicOk);
  const reasons = {};
  for (const r of results.filter((x) => !x.guardPass)) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
  const summary = {
    mode, events: n, errors: n - called.length,
    guardPass: guardPass.length, acceptable: acceptable.length, reasons,
    distinct: new Set(guardPass.map((r) => r.line.toLowerCase())).size,
    wall: stats(warm.map((r) => r.wallMs)), firstToken: stats(warm.map((r) => r.firstTokenMs)),
    sessionStart: stats(starts.map((r) => r.wallMs)),
    withinBudget: warm.filter((r) => r.wallMs <= BUDGET_MS).length, warmCalls: warm.length,
  };
  return { summary, results };
}

async function main() {
  const total = Number(arg('events', 96));
  const seed = Number(arg('seed', 1));
  const model = arg('model', 'claude-haiku-5-5');
  const mode = arg('mode', 'both');
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const binary = claudeBinary();
  const events = makeEvents(total, seeded(seed));
  const modes = mode === 'both' ? ['session', 'fresh'] : [mode];
  console.error(`${events.length} events, model ${model}, modes ${modes.join(' + ')} (this uses the Claude subscription)`);

  const runs = {};
  for (const m of modes) runs[m] = await run(m, sdk, model, binary, events);

  if (arg('json')) fs.writeFileSync(arg('json'), JSON.stringify({ model, seed, runs }, null, 1));

  // ---- Markdown ----
  const local = arg('local-json') ? JSON.parse(fs.readFileSync(arg('local-json'), 'utf8')) : null;
  const L = local && local.summary;
  const n = events.length;
  const cols = [['Local model (CPU)', 'local'], ...modes.map((m) => [m === 'session' ? 'Haiku, running session' : 'Haiku, fresh process', m])];
  const cell = (key, fn) => cols.map(([, id]) => {
    if (id === 'local') return L ? fn.local(L) : 'n/a';
    return fn.haiku(runs[id].summary, runs[id]);
  });
  const row = (label, fn) => `| ${label} | ${cell(label, fn).join(' | ')} |`;
  const md = [];
  md.push(`## Local model against Claude Haiku (hand-added, ${new Date().toISOString().slice(0, 10)})`);
  md.push('');
  md.push(`Measured by \`scripts/measure-haiku.js\` on ${n} synthetic events, seed ${seed}, the same events for both models. Haiku (\`${model}\`) is zero shot with the same persona and signals line the local model gets, called through the Agent SDK on the Claude subscription. Its answers go through the same petBrain guards and the same scoring. Haiku's own timeout was lifted so slow answers still count for quality; speed against the app's ${BUDGET_MS} ms budget is its own row.`);
  md.push('');
  md.push(`| Measure | ${cols.map(([name]) => name).join(' | ')} |`);
  md.push(`|---|${cols.map(() => '---').join('|')}|`);
  md.push(row('Typical line (p50)', { local: (s) => ms(s.warm.p50), haiku: (s) => ms(s.wall.p50) }));
  md.push(row('Slow line (p95)', { local: (s) => ms(s.warm.p95), haiku: (s) => ms(s.wall.p95) }));
  md.push(row('Slowest line', { local: (s) => ms(s.warm.max), haiku: (s) => ms(s.wall.max) }));
  md.push(row(`Lines inside the ${BUDGET_MS} ms budget`, { local: (s) => pct(s.events - s.timeouts, s.events), haiku: (s) => pct(s.withinBudget, s.warmCalls) }));
  md.push(row('Time to first token (p50)', { local: () => 'n/a', haiku: (s) => ms(s.firstToken.p50) }));
  md.push(row('First call after start', { local: (s) => `${ms(s.coldFirstCallMs)}, after a ${ms(s.loadMs)} load`, haiku: (s) => (s.sessionStart.n ? `${ms(s.sessionStart.p50)} (starts the CLI process)` : 'n/a') }));
  md.push(row('Passes the guards', { local: (s) => pct(Math.round(s.guardPassRate * s.events), s.events), haiku: (s) => pct(s.guardPass, s.events) }));
  md.push(row('Acceptable (guards, length, on topic)', { local: (s) => pct(Math.round(s.acceptableRate * s.events), s.events), haiku: (s) => pct(s.acceptable, s.events) }));
  md.push(row('Failed calls', { local: (s) => `${s.timeouts} timeouts`, haiku: (s) => `${s.errors} errors` }));
  md.push('');
  md.push('"Typical" and "slow" are the middle and the 95th percentile of the warm calls. For the running session they exclude the first call of each session of 16; for the fresh process they exclude only the first call. The local figures are the CPU default and are measured inside the app\'s own backend; the local model needs about 1.5 GB of memory while loaded and Haiku needs none. The SDK also reports an API duration per call; it was left out because it can exceed the whole call time.');
  md.push('');
  for (const m of modes) {
    const rejected = runs[m].results.filter((r) => !r.guardPass && r.rawText).slice(0, 5);
    md.push(`Haiku lines the guards rejected (${m}):`);
    for (const r of rejected) md.push(`- ${r.reaction}, ${r.reason}: "${String(r.rawText).replace(/\s+/g, ' ').slice(0, 110)}"`);
    if (!rejected.length) md.push('- (none)');
    md.push('');
    if (m === modes[0]) {
      md.push('First two accepted Haiku lines for eight reactions:');
      for (const reaction of REACTIONS.slice(0, 8)) {
        const lines = runs[m].results.filter((r) => r.reaction === reaction && r.guardPass).slice(0, 2).map((r) => `"${r.line}"`);
        md.push(`- **${reaction}**: ${lines.join('; ') || '(none accepted)'}`);
      }
      md.push('');
    }
  }
  if (arg('out')) fs.writeFileSync(arg('out'), md.join('\n'));
  console.log(md.join('\n'));
}

main().catch((err) => { console.error(err); process.exit(1); });
