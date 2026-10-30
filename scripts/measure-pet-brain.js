'use strict';
// Feeds synthetic events through the real local model and the real petBrain guards, and reports how
// good and how fast Smart lines is. Not part of the app. Run by hand:
//
//   node scripts/measure-pet-brain.js --model /path/to/model.gguf [--events 500] [--seed 1]
//        [--gpu cpu|metal] [--threads 4] [--out docs/PET_BRAIN_METRICS.md] [--json results.json]
//
// What "acceptable" means here, all three at once:
//   1. passes the guards: petBrain accepted the model's line (length and character rules, banned words,
//      persona rules, no contradiction with the signals, no repeat, no cut-off), so it would be shown
//   2. sensible length: 4 to 14 words, within the character limit, ends like a sentence
//   3. on topic: shares at least one content word with the owner-approved built-in lines for that reaction
// (3) is a keyword heuristic, not a judgment of wit or fit. It is calibrated by scoring the built-in
// lines the same way (each line against the other four), which is reported as the baseline.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkerBackend, createPetBrain } = require('../vendor/pet-brain/petBrain.js');
const { reactionFor, REACTIONS, APP_CATEGORIES, TYPING, MUSIC, EVENTS } = require('../vendor/pet-brain/rules.js');
const { MAX_LINE_CHARS } = require('../vendor/pet-brain/lineCheck.js');
const canned = require('../vendor/pet-brain/canned.json');
const { fallbackReason } = require('../pet/reactions.js');
const { verifyModelFile } = require('../pet/modelService.js');
const { MODEL_CONFIG } = require('../pet/config.js');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- Synthetic events: about the same number per reaction, signals chosen at random until the rules agree ----

function randomSignals(rand) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const r = rand();
  const idle = r < 0.45 ? Math.floor(rand() * 60) : r < 0.7 ? 60 + Math.floor(rand() * 540) : 600 + Math.floor(rand() * 3000);
  return {
    app_category: pick(APP_CATEGORIES),
    idle_s: idle,
    typing: pick(TYPING),
    hour: Math.floor(rand() * 24),
    music: pick(MUSIC),
    event: rand() < 0.3 ? pick(EVENTS) : 'none',
  };
}

function makeEvents(total, rand) {
  const events = [];
  const base = Math.floor(total / REACTIONS.length);
  const extra = total - base * REACTIONS.length;
  REACTIONS.forEach((reaction, i) => {
    const want = base + (i < extra ? 1 : 0);
    let found = 0;
    for (let tries = 0; found < want && tries < 500000; tries += 1) {
      const signals = randomSignals(rand);
      if (reactionFor(signals) === reaction) { events.push({ reaction, signals }); found += 1; }
    }
    if (found < want) throw new Error(`could not generate events for ${reaction}`);
  });
  for (let i = events.length - 1; i > 0; i -= 1) { // interleave the reactions
    const j = Math.floor(rand() * (i + 1));
    [events[i], events[j]] = [events[j], events[i]];
  }
  return events;
}

// ---- Scoring ----

const STOP = new Set(('the and for you your are but not with that this have has had was were will would can could should just from they them their there then than into over out its our any all one too very more some what when who how why been being does did done get got let like also only about than here still even much many such each other these those while after before again once ever never now off yet its').split(' '));
function stems(text) {
  return String(text).toLowerCase().replace(/[^a-z ]+/g, ' ').split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map((w) => w.replace(/(ing|ed|ly|es|s)$/, ''));
}
function onTopic(line, reaction, skipLine) {
  const anchor = new Set();
  for (const other of canned[reaction]) if (other !== skipLine) for (const s of stems(other)) anchor.add(s);
  return stems(line).some((s) => anchor.has(s));
}
function sensibleLength(line) {
  const words = line.trim().split(/\s+/).length;
  return words >= 4 && words <= 14 && line.length <= MAX_LINE_CHARS && /[.!?]["')]?$/.test(line);
}

const quantile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] : null);
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');
const ms = (n) => (n == null ? 'n/a' : `${Math.round(n)} ms`);

async function main() {
  const modelPath = arg('model', process.env.PET_BRAIN_MODEL_PATH);
  if (!modelPath || !fs.existsSync(modelPath)) { console.error('pass --model PATH (the GGUF file)'); process.exit(1); }
  const total = Number(arg('events', 500));
  const seed = Number(arg('seed', 1));
  const gpu = arg('gpu', MODEL_CONFIG.gpu);
  const threads = Number(arg('threads', MODEL_CONFIG.threads));
  process.env.PET_BRAIN_GPU = gpu;

  const check = await verifyModelFile(modelPath);
  if (!check.ok) { console.error(`model file is not the expected one (${check.why})`); process.exit(1); }

  const events = makeEvents(total, seeded(seed));
  console.error(`generated ${events.length} events; loading the model (gpu=${gpu}, threads=${threads})...`);

  const rssStart = process.memoryUsage().rss;
  const backend = createWorkerBackend({ modelPath, threads, maxTokens: 28, temperature: 0.7, startupTimeoutMs: 120000 });
  const loadStart = process.hrtime.bigint();
  const ready = await backend.start();
  const loadMs = Number(process.hrtime.bigint() - loadStart) / 1e6;
  if (!ready) { console.error('the model did not load'); await backend.dispose(); process.exit(1); }
  let rssPeak = process.memoryUsage().rss;
  const rssTimer = setInterval(() => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss); }, 250);
  const rssLoaded = process.memoryUsage().rss;

  // A fresh brain per event (so one bad line cannot switch the model off for the rest of the run)
  // sharing one loaded model. The wrapper records each raw answer and its call time.
  let lastRaw = null;
  let lastCallMs = null;
  const shared = {
    start: async () => true,
    generate: async (prompt, options) => {
      const t = process.hrtime.bigint();
      try { lastRaw = await backend.generate(prompt, options); } finally { lastCallMs = Number(process.hrtime.bigint() - t) / 1e6; }
      return lastRaw;
    },
    dispose: async () => {},
  };

  const results = [];
  for (let i = 0; i < events.length; i += 1) {
    const { reaction, signals } = events[i];
    const brain = createPetBrain({ backend: shared, timeoutMs: MODEL_CONFIG.timeoutMs, cooldownMs: 0 });
    await brain.ready;
    lastRaw = null; lastCallMs = null;
    const before = brain.stats();
    const t = process.hrtime.bigint();
    const out = await brain.react(signals);
    const endToEndMs = Number(process.hrtime.bigint() - t) / 1e6;
    const reason = out.source === 'model' ? null : fallbackReason(before, brain.stats(), null);
    const rawText = lastRaw ? (typeof lastRaw === 'string' ? lastRaw : lastRaw.text) : null;
    const accepted = out.source === 'model';
    results.push({
      i, reaction, signals, source: out.source, line: out.line, reason, rawText, endToEndMs, callMs: lastCallMs,
      guardPass: accepted,
      lengthOk: accepted && sensibleLength(out.line),
      topicOk: accepted && onTopic(out.line, reaction, null),
    });
    if ((i + 1) % 50 === 0) console.error(`  ${i + 1}/${events.length}`);
  }
  clearInterval(rssTimer);
  await backend.dispose();

  // ---- Summary ----
  const n = results.length;
  const guardPass = results.filter((r) => r.guardPass);
  const acceptable = results.filter((r) => r.guardPass && r.lengthOk && r.topicOk);
  const fellBack = results.filter((r) => !r.guardPass);
  const reasons = {};
  for (const r of fellBack) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
  const calls = results.filter((r) => r.callMs != null);
  const cold = results[0];
  const warm = results.slice(1).filter((r) => r.callMs != null);
  const warmCall = warm.map((r) => r.callMs).sort((a, b) => a - b);
  const warmE2E = results.slice(1).map((r) => r.endToEndMs).sort((a, b) => a - b);
  const mean = (list) => list.reduce((a, b) => a + b, 0) / (list.length || 1);

  // Baseline: score the built-in lines the same way, each against the other four.
  let cannedTopic = 0; let cannedLen = 0; let cannedTotal = 0;
  for (const reaction of REACTIONS) {
    for (const line of canned[reaction]) {
      cannedTotal += 1;
      if (onTopic(line, reaction, line)) cannedTopic += 1;
      if (sensibleLength(line)) cannedLen += 1;
    }
  }

  const perReaction = REACTIONS.map((reaction) => {
    const rs = results.filter((r) => r.reaction === reaction);
    return { reaction, n: rs.length, guard: rs.filter((r) => r.guardPass).length, ok: rs.filter((r) => r.guardPass && r.lengthOk && r.topicOk).length,
      topic: rs.filter((r) => r.guardPass && r.topicOk).length };
  });

  const distinct = new Set(guardPass.map((r) => r.line.toLowerCase())).size;
  const summary = {
    when: new Date().toISOString().slice(0, 10),
    machine: `${os.cpus()[0].model}, ${os.cpus().length} cores, ${Math.round(os.totalmem() / 2 ** 30)} GB, ${os.platform()} ${os.arch()}`,
    node: process.version, nodeLlamaCpp: JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'node-llama-cpp', 'package.json'), 'utf8')).version,
    gpu, threads, events: n, seed,
    guardPassRate: guardPass.length / n, acceptableRate: acceptable.length / n, fallbackRate: fellBack.length / n,
    lengthOkAmongGuardPass: guardPass.filter((r) => r.lengthOk).length / (guardPass.length || 1),
    topicOkAmongGuardPass: guardPass.filter((r) => r.topicOk).length / (guardPass.length || 1),
    cannedBaselineTopic: cannedTopic / cannedTotal, cannedBaselineLength: cannedLen / cannedTotal,
    reasons, loadMs, rssStartMB: rssStart / 2 ** 20, rssLoadedMB: rssLoaded / 2 ** 20, rssPeakMB: rssPeak / 2 ** 20,
    coldFirstCallMs: cold && cold.callMs, warm: { n: warmCall.length, p50: quantile(warmCall, 0.5), p95: quantile(warmCall, 0.95), p99: quantile(warmCall, 0.99), max: warmCall[warmCall.length - 1], mean: mean(warmCall) },
    endToEnd: { p50: quantile(warmE2E, 0.5), p95: quantile(warmE2E, 0.95), max: warmE2E[warmE2E.length - 1] },
    timeouts: results.filter((r) => r.reason === 'timeout').length,
    distinctAccepted: distinct, accepted: guardPass.length,
  };

  const jsonOut = arg('json');
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ summary, perReaction, results }, null, 1));

  // ---- Markdown ----
  const sample = (reaction, k) => results.filter((r) => r.reaction === reaction && r.guardPass).slice(0, k).map((r) => r.line);
  const rejected = results.filter((r) => !r.guardPass && r.rawText).slice(0, 12);
  const md = [];
  md.push('# Pet brain metrics: Smart lines');
  md.push('');
  md.push(`Measured ${summary.when} by \`scripts/measure-pet-brain.js\`. ${n} synthetic events, about ${Math.round(n / REACTIONS.length)} per reaction, seed ${seed}, run through the real local model and the real petBrain guards (the same code the app uses). Regenerate with:`);
  md.push('');
  md.push('```');
  md.push(`node scripts/measure-pet-brain.js --model /path/to/deadpan_v1_qwen3.5-0.8b-q4_k_m.gguf --gpu ${gpu} --threads ${threads} --out docs/PET_BRAIN_METRICS.md`);
  md.push('```');
  md.push('');
  md.push('## Setup');
  md.push('');
  md.push(`- Machine: ${summary.machine}`);
  md.push(`- Runtime: Node ${summary.node}, node-llama-cpp ${summary.nodeLlamaCpp}, model \`${path.basename(modelPath)}\` (hash checked against the manifest)`);
  md.push(`- Inference: ${gpu === 'metal' ? 'Metal (GPU)' : 'CPU (macOS: the Metal binary with zero GPU layers)'}, ${threads} threads, 28 token cap, temperature 0.7, ${MODEL_CONFIG.timeoutMs} ms timeout per line`);
  md.push('- Each event gets a fresh brain around one shared, already loaded model, so one bad line cannot switch the model off for the rest of the run');
  md.push('');
  md.push('## Quality');
  md.push('');
  md.push('| Measure | Result |');
  md.push('|---|---|');
  md.push(`| **Acceptable** (passes guards, sensible length, on topic) | **${pct(acceptable.length, n)}** (${acceptable.length} of ${n}) |`);
  md.push(`| Passes the guards (would be shown) | ${pct(guardPass.length, n)} (${guardPass.length}) |`);
  md.push(`| **Fallback to a built-in line** | **${pct(fellBack.length, n)}** (${fellBack.length}) |`);
  md.push(`| Sensible length, of guard-passing lines | ${pct(guardPass.filter((r) => r.lengthOk).length, guardPass.length)} |`);
  md.push(`| On topic (keyword heuristic), of guard-passing lines | ${pct(guardPass.filter((r) => r.topicOk).length, guardPass.length)} |`);
  md.push(`| Baseline: built-in lines scored the same way, sensible length | ${pct(cannedLen, cannedTotal)} |`);
  md.push(`| Baseline: built-in lines scored the same way, on topic | ${pct(cannedTopic, cannedTotal)} |`);
  md.push(`| Distinct lines among accepted | ${distinct} of ${guardPass.length} |`);
  md.push('');
  md.push('"On topic" only checks that a line shares a content word with the owner-approved built-in lines for that reaction, so it misses dry lines that fit without the obvious words and passes lines that use the words without fitting. The baseline row shows how the hand-written lines score on the same test. It says nothing about wit or voice. The package\'s own evaluation found the model\'s lines lose to the built-in bank in blind comparison (see `vendor/pet-brain/manifest.json`, `eval`); that finding is not re-run here.');
  md.push('');
  md.push('### Why lines fell back');
  md.push('');
  md.push('| Reason | Count |');
  md.push('|---|---|');
  for (const [reason, count] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) md.push(`| ${reason} | ${count} |`);
  if (!fellBack.length) md.push('| (none) | 0 |');
  md.push('');
  md.push('Reasons are petBrain\'s own: `invalid` (length or character rule), `persona`, `contradicts-signals`, `repeat`, `exclamation-rate`, `truncated`, `banned-word`, `timeout`, `aborted`, `error`.');
  md.push('');
  md.push('## Latency');
  md.push('');
  md.push('| Measure | Result |');
  md.push('|---|---|');
  md.push(`| Model load (cold start of the worker, includes warm-up) | ${ms(loadMs)} |`);
  md.push(`| First line after load ("cold" line) | ${ms(cold && cold.callMs)} |`);
  md.push(`| Warm line, model call: p50 / p95 / p99 / max | ${ms(summary.warm.p50)} / ${ms(summary.warm.p95)} / ${ms(summary.warm.p99)} / ${ms(summary.warm.max)} |`);
  md.push(`| Warm line, mean | ${ms(summary.warm.mean)} |`);
  md.push(`| Warm line, end to end through petBrain: p50 / p95 / max | ${ms(summary.endToEnd.p50)} / ${ms(summary.endToEnd.p95)} / ${ms(summary.endToEnd.max)} |`);
  md.push(`| Lines over the ${MODEL_CONFIG.timeoutMs} ms timeout | ${summary.timeouts} of ${n} |`);
  md.push(`| Memory (this process): before load / loaded / peak | ${Math.round(summary.rssStartMB)} MB / ${Math.round(summary.rssLoadedMB)} MB / ${Math.round(summary.rssPeakMB)} MB |`);
  md.push('');
  md.push(`Warm numbers are the ${warmCall.length} lines after the first. The load time depends on whether the model file is already in the operating system's file cache (a first-ever load from disk is several seconds slower); this run did not clear the cache. In the app the first ambient line after a load or an idle unload is a built-in line, because the model is loading in the background (see Decisions made).`);
  md.push('');
  md.push('## By reaction');
  md.push('');
  md.push('| Reaction | Events | Passed guards | Acceptable |');
  md.push('|---|---|---|---|');
  for (const p of perReaction) md.push(`| ${p.reaction} | ${p.n} | ${pct(p.guard, p.n)} | ${pct(p.ok, p.n)} |`);
  md.push('');
  md.push('## Sample lines');
  md.push('');
  md.push('First two accepted lines for each reaction, as written by the model:');
  md.push('');
  for (const reaction of REACTIONS) {
    const lines = sample(reaction, 2);
    md.push(`- **${reaction}**: ${lines.length ? lines.map((l) => `"${l}"`).join('; ') : '(none accepted)'}`);
  }
  md.push('');
  md.push('### Rejected by the guards (raw model output)');
  md.push('');
  for (const r of rejected) md.push(`- ${r.reaction}, ${r.reason}: "${String(r.rawText).replace(/\s+/g, ' ').slice(0, 110)}"`);
  if (!rejected.length) md.push('- (none)');
  md.push('');

  const outFile = arg('out');
  if (outFile) fs.writeFileSync(outFile, md.join('\n'));
  console.log(JSON.stringify(summary, null, 1));
}

main().catch((err) => { console.error(err); process.exit(1); });
