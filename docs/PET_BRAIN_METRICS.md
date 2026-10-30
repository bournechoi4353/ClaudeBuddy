# Pet brain metrics: Smart lines

Measured 2026-10-30 by `scripts/measure-pet-brain.js`. 500 synthetic events, about 21 per reaction, seed 1, run through the real local model and the real petBrain guards (the same code the app uses). Regenerate with:

```
node scripts/measure-pet-brain.js --model /path/to/deadpan_v1_qwen3.5-0.8b-q4_k_m.gguf --gpu cpu --threads 4 --out docs/PET_BRAIN_METRICS.md
```

## Setup

- Machine: Apple M4, 10 cores, 16 GB, darwin arm64
- Runtime: Node v25.2.1, node-llama-cpp 3.22.2, model `deadpan_v1_qwen3.5-0.8b-q4_k_m.gguf` (hash checked against the manifest)
- Inference: CPU (macOS: the Metal binary with zero GPU layers), 4 threads, 28 token cap, temperature 0.7, 1500 ms timeout per line
- Each event gets a fresh brain around one shared, already loaded model, so one bad line cannot switch the model off for the rest of the run

## Quality

| Measure | Result |
|---|---|
| **Acceptable** (passes guards, sensible length, on topic) | **75.2%** (376 of 500) |
| Passes the guards (would be shown) | 99.2% (496) |
| **Fallback to a built-in line** | **0.8%** (4) |
| Sensible length, of guard-passing lines | 100.0% |
| On topic (keyword heuristic), of guard-passing lines | 75.8% |
| Baseline: built-in lines scored the same way, sensible length | 100.0% |
| Baseline: built-in lines scored the same way, on topic | 44.2% |
| Distinct lines among accepted | 488 of 496 |

"On topic" only checks that a line shares a content word with the owner-approved built-in lines for that reaction, so it misses dry lines that fit without the obvious words and passes lines that use the words without fitting. The baseline row shows how the hand-written lines score on the same test. It says nothing about wit or voice. The package's own evaluation found the model's lines lose to the built-in bank in blind comparison (see `vendor/pet-brain/manifest.json`, `eval`); that finding is not re-run here.

### Why lines fell back

| Reason | Count |
|---|---|
| contradicts-signals | 3 |
| persona | 1 |

Reasons are petBrain's own: `invalid` (length or character rule), `persona`, `contradicts-signals`, `repeat`, `exclamation-rate`, `truncated`, `banned-word`, `timeout`, `aborted`, `error`.

## Latency

| Measure | Result |
|---|---|
| Model load (cold start of the worker, includes warm-up) | 1367 ms |
| First line after load ("cold" line) | 265 ms |
| Warm line, model call: p50 / p95 / p99 / max | 216 ms / 260 ms / 284 ms / 346 ms |
| Warm line, mean | 218 ms |
| Warm line, end to end through petBrain: p50 / p95 / max | 216 ms / 260 ms / 407 ms |
| Lines over the 1500 ms timeout | 0 of 500 |
| Memory (this process): before load / loaded / peak | 111 MB / 1534 MB / 1652 MB |

Warm numbers are the 499 lines after the first. The load time depends on whether the model file is already in the operating system's file cache (a first-ever load from disk is several seconds slower); this run did not clear the cache. In the app the first ambient line after a load or an idle unload is a built-in line, because the model is loading in the background (see Decisions made).

## By reaction

| Reaction | Events | Passed guards | Acceptable |
|---|---|---|---|
| focused | 21 | 95.2% | 47.6% |
| stuck | 21 | 100.0% | 100.0% |
| celebrate | 21 | 100.0% | 85.7% |
| late_night | 21 | 100.0% | 28.6% |
| long_idle | 21 | 100.0% | 95.2% |
| welcome_back | 21 | 100.0% | 100.0% |
| new_song | 21 | 100.0% | 85.7% |
| music_paused | 21 | 95.2% | 85.7% |
| fast_context_switching | 21 | 100.0% | 90.5% |
| error_spotted | 21 | 100.0% | 100.0% |
| break_suggestion | 21 | 100.0% | 85.7% |
| greeting | 21 | 100.0% | 100.0% |
| goodnight | 21 | 100.0% | 100.0% |
| morning_start | 21 | 100.0% | 95.2% |
| deep_work_streak | 21 | 95.2% | 42.9% |
| music_vibe | 21 | 100.0% | 95.2% |
| game_time | 21 | 95.2% | 23.8% |
| video_watching | 21 | 100.0% | 33.3% |
| chat_chatter | 21 | 100.0% | 52.4% |
| reading_docs | 21 | 100.0% | 9.5% |
| fast_typing | 20 | 100.0% | 65.0% |
| short_idle | 20 | 100.0% | 100.0% |
| hydrate_nudge | 20 | 100.0% | 90.0% |
| lunch_break | 20 | 100.0% | 95.0% |

## Sample lines

First two accepted lines for each reaction, as written by the model:

- **focused**: "Good focus. I'll keep the commentary to myself."; "Genuinely calm. The work is going well."
- **stuck**: "Build failed. I'm keeping the embarrassment in."; "Build failed. Let's call it a good lesson."
- **celebrate**: "It built. It didn't shout. That's my kind of win."; "Build passed. I'm very good at that."
- **late_night**: "Everyone's asleep. I'll take the burden."; "It's practically midnight. Respect."
- **long_idle**: "Long time. The place hasn't changed a lot."; "Away for ages. I took the fort. Barely."
- **welcome_back**: "Welcome back. We're all very, very confused."; "Welcome back. The place has shown you some patience."
- **new_song**: "A new sound. Let's see if it's worth the wait."; "A new sound is arriving. Let's keep the noise level under control."
- **music_paused**: "Silence arrived. Quiet and firm."; "Quiet now. The rest can wait."
- **fast_context_switching**: "Racing between things. Brilliant. Unremarkable."; "A lot of switching. I'll hold the map."
- **error_spotted**: "An error has appeared. It shows little."; "An error has arrived. It's being very dramatic."
- **break_suggestion**: "You've been doing this a lot. A short break might not hurt."; "Long session. A break would be defensible and appreciated."
- **greeting**: "Hello. I'm here to be useful and mildly supportive."; "Hello. Let's not ruin the day with it."
- **goodnight**: "Goodnight. I'll be minimal. Mostly."; "Goodnight. I'll be a goodnighter."
- **morning_start**: "Another day has begun. I'll hold the quiet."; "Good start. Everything will get better."
- **deep_work_streak**: "Long and fast. A true partnership in disguise."; "Long haul. The dedication is palpable."
- **music_vibe**: "The soundtrack is good. I'm just saying."; "Good sound. It's improving the work."
- **game_time**: "Game time. I'll stay supportive, not a game."; "You're in charge. I'm just the consultant."
- **video_watching**: "Enjoy the show. I'll act supportive, but it's very low-key."; "Enjoy. I'll be the quiet companion."
- **chat_chatter**: "Brief discussion. I'll keep the mood from getting annoyed."; "Conversation is going well. I'll keep the company quiet."
- **reading_docs**: "Reading carefully. The work is not getting any better."; "Reading slowly. I'll keep the commentary to myself."
- **fast_typing**: "That was a lot of work. I'm surprised it didn't break the bank."; "That was impressive. I'm going to call it a study session."
- **short_idle**: "Away for a bit. I'll keep the house in order."; "Brief pause. The rest will be there."
- **hydrate_nudge**: "You've been very productive. Water would be a good addition."; "Water is cheap, and you've earned it."
- **lunch_break**: "Food is a good idea. I'm just saying."; "Food is free, probably. Consider it."

### Rejected by the guards (raw model output)

- focused, contradicts-signals: "You're on the right track. I'm just saying."
- deep_work_streak, persona: "Long and steady. I'd say it's improving things, but I'm not one to overvalue it."
- game_time, contradicts-signals: "Gone for ages. I'll practice being there."
- music_paused, contradicts-signals: "Silence has arrived. It's been quiet for ages."

## Metal comparison (hand-added from a second run)

The sections from here down are not produced by the script, so re-running the script replaces the sections above and drops these. The second run used the same 500 events and seed with `--gpu metal`.

| Measure | CPU (app default) | Metal |
|---|---|---|
| Passes the guards | 99.2% | 99.2% |
| Acceptable (guards, length, on topic) | 75.2% | 78.2% |
| Fallback to a built-in line | 0.8% | 0.8% |
| Model load | 1367 ms | 2219 ms |
| First line after load | 265 ms | 258 ms |
| Warm line p50 / p95 / max | 216 ms / 260 ms / 346 ms | 151 ms / 193 ms / 223 ms |
| Peak memory of the process | 1652 MB | 1445 MB |
| Lines over the 1500 ms timeout | 0 | 0 |

Quality is the same within the run-to-run noise of a temperature 0.7 model (the acceptable rate differs by about 3 points, the guard pass rate is identical). Metal is about 30 percent faster. CPU is already about six times inside the 1500 ms budget at p95, so the app defaults to CPU, which does not wake the GPU for a background pet. `MODEL_CONFIG.gpu` in `pet/config.js` switches it.

## Inside Electron (hand-added)

Run on this Mac with Electron 33.4.11 (Node 20.18.3, arm64):

- `node-llama-cpp` loads and writes lines **inside Electron's main process**, through the package's worker thread, in both modes. `scripts/electron-model-check.js` also loads the model directly on the main thread. The docs' warning about `utilityProcess` was not needed and that route was not tried.
- Worker thread in Electron main, five lines: CPU 207 to 248 ms each, Metal 119 to 225 ms each. Load took 1.6 to 6.2 s on CPU (6.2 s was the first load after the file had been out of the file cache) and 1.8 to 2.3 s on Metal.
- The real controller, model service, worker and model together, four ambient lines in a row: line 1 built in (`fallback=cold-start`, 2 ms) while the model loaded in the background (1.78 s), lines 2 to 4 from the model at 266, 233 and 246 ms. Turning Smart lines off unloaded the model at once. The process exited cleanly.
- The **packaged** app (`electron-builder --mac --dir`, self-signed, hardened runtime flag set), run with Smart lines on: the first ambient line was built in, then `model loaded in 5893 ms` (a first load from a freshly written bundle), then a clean shutdown with the model unloaded. See Packaging risks in `docs/PET_BRAIN.md`.

## A manual read of the samples (hand-added)

The guards check rules, not quality, and the keyword test above is weak (the hand-written lines score only 44 percent on it). So the assistant that wrote this report read the 48 sample lines above (two per reaction) and marked each one that fits the reaction and the deadpan, on-the-user's-side persona, against ones that are odd, incoherent or off-persona.

- Fine: **34 of 48** (71 percent). Examples: "Goodnight. I'll be minimal. Mostly.", "It built. It didn't shout. That's my kind of win.", "Water is cheap, and you've earned it.", "An error has arrived. It's being very dramatic."
- Odd, incoherent or off-persona: **14 of 48** (29 percent). Examples: "Goodnight. I'll be a goodnighter.", "Long and fast. A true partnership in disguise.", "Game time. I'll stay supportive, not a game.", "An error has appeared. It shows little.", "Reading carefully. The work is not getting any better." (negative about the user's work), "Welcome back. We're all very, very confused."

This is one reader, a single pass, and the reader is a model, so treat it as a rough check on the 75 percent figure and not as a measurement. It agrees with the package's own finding (`vendor/pet-brain/manifest.json`, `eval`): the lines are fluent and fit the reaction, but they are rarely dry or funny, some are odd, and they lose to the hand-written bank in blind comparison. The guards pass those odd lines too, which is why 99.2 percent passing the guards and about 70 to 75 percent being good are both true.
