# Pet brain

An optional layer that gives the desktop pet a small personality of its own. It is off by default, lives on the `ml-pet-brain` branch, and when it is off the app behaves exactly as it did before.

What it does when on:

- The pet becomes a raincloud (a new original sprite) instead of the crab.
- It watches coarse signals (which kind of app is in front, how long you have been idle, the time of day, whether Spotify is playing) and picks a reaction with deterministic rules.
- It shows one short line from a hand-written bank for that reaction, and a matching pose.
- Optionally, it matches the weather when idle.
- Optionally (Smart lines), a small local language model writes the line instead of the built-in bank, with the bank as the fallback.

Nothing here reads window titles, URLs, document names, screenshots or keystroke content. The whole thing runs on the user's machine. The only network request is the opt-in weather lookup.

Two tiers answer two kinds of thing. The pet's own unprompted lines are tier 1 (rules, then the local model or the built-in bank). Anything the user asks is tier 2 and goes to Claude exactly as it always has. See Routing below.

## Running it

```
PET_BRAIN_LOCAL=1 npm start
```

From VS Code's terminal, also strip the inherited variable: `env -u ELECTRON_RUN_AS_NODE PET_BRAIN_LOCAL=1 npm start`.

| Variable | Effect |
|---|---|
| `PET_BRAIN_LOCAL=1` | Opens the gate. Off by default, and only the exact value `1` counts. |
| `PET_BRAIN_DEBUG=1` | Logs every reaction decision, block reason, pose change and weather pose to the console as `[pet-brain] ...`, and one metrics line per ambient line (source, latency, fallback reason). |
| `PET_BRAIN_MODEL_PATH=/path/model.gguf` | Where Smart lines looks for the model, unless Preferences sets a path. |

With the gate open, a **Pet brain** section appears in Preferences (master switch, chattiness, reset line history, weather mood). The master switch is a soft off: it lets the user turn the brain off without unsetting the environment variable. Preferences alone can never open the gate.

A packaged app launched by double click has no environment variable, so the gate stays closed. To try a packaged build: `PET_BRAIN_LOCAL=1 open -a Clawd` from a terminal, or `launchctl setenv PET_BRAIN_LOCAL 1` before opening it.

Hidden debug aid: while the brain is active, the tray and right-click menu has **Pet brain: cycle all poses**, which steps through all 23 poses every 2.5 seconds and names each one in the bubble.

## Architecture

```
main process                                         renderer (pet window)
------------                                         ---------------------
platform.js        idle, front app, music, fullscreen
   |
pet/controller.js  samples once a second, evaluates every 5 s
   |   pet/events.js        raw samples -> signals + one-shot events   (pure)
   |   pet/reactions.js     cooldowns, gaps, fullscreen gate           (pure)
   |   vendor/pet-brain     rules.js picks the reaction, petBrain.js picks the line
   |   pet/modelService.js  Smart lines: lazy local model behind petBrain (off by default)
   |   pet/weatherService.js  opt-in weather pose
   |
   +--- IPC: pet-brain-state / pet-brain-bubble / pet-brain-weather ---> renderer/petSprite.js
                                                                          |  raincloud sprite in place of the crab
                                                                          |  bubble through crab.js showThought()
```

Files:

| Path | Role |
|---|---|
| `pet/flag.js` | The one place that decides whether the brain runs. Has no requires, so checking it loads nothing. |
| `pet/config.js` | Every tunable number: cooldowns, gaps, thresholds, chattiness multipliers. |
| `pet/appCategories.js` | App name to category (`code_editor`, `browser`, ...). Names only. |
| `pet/events.js` | Turns raw samples into the signal object `rules.js` expects. Pure, takes its time from the caller. |
| `pet/reactions.js` | Decides whether a reaction may show a bubble now, then asks the brain for a line. |
| `pet/controller.js` | Main-process glue. Samples signals, runs the layers, sends results to the renderer. |
| `pet/modelService.js` | Smart lines. Loads the local model lazily, unloads it when idle, never blocks. Does nothing unless enabled and the model file is present and the expected one. |
| `pet/router.js` | The fixed routing table: ambient goes to the local tier, everything else to Claude. |
| `pet/weatherService.js` | Opt-in weather. Does nothing until enabled and given a place. |
| `pet/prefs.js` | Validation of the pet brain's own preferences. |
| `vendor/pet-brain/` | The pet brain package: `rules.js`, `petBrain.js`, line and persona checks, `canned.json`, `weather.js`, `manifest.json` (the model's size and hash) and `worker.js` (the model worker). All unmodified except `worker.js`, which has one marked patch, see Decisions made. |
| `scripts/measure-pet-brain.js` | Feeds 500 synthetic events through the real model and writes `docs/PET_BRAIN_METRICS.md`. |
| `scripts/electron-model-check.js` | Loads the model inside real Electron main, to check the native module works there. |
| `renderer/petSprite.js` | Draws the raincloud and shows bubbles. Inert unless the page was loaded with `?petbrain=1`. |
| `renderer/raincloud/` | The sprite sheet, its manifest and its small player. |

### Signals

| Signal | Source | Notes |
|---|---|---|
| `app_category` | `platform.getFrontmostApp()` via the existing 2 s poll, mapped by `pet/appCategories.js` | Unknown apps are `other`. |
| `idle_s` | Electron `powerMonitor.getSystemIdleTime()`, once a second | |
| `hour` | Local clock | |
| `music` | `platform.getMusicState()`, every 20 s | macOS and Spotify only. Reports `none` on Windows. Never launches Spotify. |
| `typing` | **Approximation**: the share of the last 30 s with input of any kind | See Known gaps. |
| `event` | `returned_from_idle`, `app_switched_often`, `long_session` are derived. `build_failed`, `build_passed`, `error_dialog` can be pushed with `controller.pushEvent()` | Nothing pushes the build and error events yet. |

### Manners

Applied in this order in `pet/reactions.js`, all values in `pet/config.js`:

1. **Startup quiet**: no bubbles for the first 30 seconds.
2. **Global gap**: at least 2 minutes between any two bubbles.
3. **Per-reaction cooldown**: from 5 minutes (`stuck`, `celebrate`, `error_spotted`) up to 6 hours (`morning_start`).
4. **Fullscreen**: no bubble while a full-screen app or presentation is in front.

Chattiness multiplies the cooldowns and the global gap: low is 2x, normal 1x, high 0.5x.

A gated reaction never asks the brain for a line, so a suppressed reaction does not use up a line. Events that are blocked by the startup quiet, the global gap or fullscreen are retried on the next evaluation until they are 60 seconds old, then dropped.

### Lines

`petBrain.js` shows each reaction's lines in shuffled cycles. Every line is shown once before any line comes round again, the same line never appears twice in a row, and a new cycle never starts with one of the last 3 lines shown. This is tested through the whole stack in `test/reactions.test.js` across many random seeds.

### Routing: who answers what

A fixed table in `pet/router.js`, plain code. The local model never decides routing, and nothing the user types can select it.

| Request | Tier | Handled by | Local model involved? |
|---|---|---|---|
| The pet's own unprompted line (a reaction bubble) | 1, ambient | rules pick the reaction, then Smart lines (local model) or the built-in bank | Yes, only here, and only if Smart lines is on |
| Anything the user types to the pet | 2, user | Claude, through `agent.js`, unchanged | Never |
| Every Gmail, Docs and Spotify action, and every other tool call | 2, user | Claude, through `tools.js`, unchanged | Never |
| Anything not in the table | 2, user | Claude | Never |

Claude is never called for an ambient line either. `test/router.test.js` enforces both directions: `agent.js`, `tools.js` and the `chat-send` handler never mention the pet brain, no pet module loads the agent or the SDK, only the controller loads the model service, and no channel the renderer can send reaches the model.

### Pose

The sprite follows the rules' live reaction, changing pose at most every 10 seconds (events change it at once). While a bubble is up, its reaction's pose is held for 8 seconds. While the pet is asleep the pose is `sleepy`. A weather pose replaces the pose only for ambient reactions (`short_idle`, `music_paused`, `video_watching`, `game_time`, `chat_chatter`, and `idle`, which is what the sprite uses when no reaction is active). It never replaces `stuck`, `celebrate`, `error_spotted` or any other event reaction.

Final reaction to pose map (from `renderer/raincloud/raincloud.json`):

| Reaction | Pose | Reaction | Pose |
|---|---|---|---|
| focused | focus | music_vibe | music |
| stuck | drizzle | game_time | idle |
| celebrate | sunbreak | video_watching | idle |
| late_night | sleepy | chat_chatter | idle |
| long_idle | fade | reading_docs | focus |
| welcome_back | hello | fast_typing | focus |
| new_song | music | short_idle | idle |
| music_paused | idle | hydrate_nudge | water |
| fast_context_switching | dizzy | lunch_break | water |
| error_spotted | storm | break_suggestion | water |
| greeting | hello | deep_work_streak | focus |
| goodnight | sleepy | morning_start | hello |

## Editing lines

Edit `vendor/pet-brain/canned.json`. It maps each reaction name to an array of lines.

- Keep at least 5 lines per reaction. With 5 lines a given line comes back after 4 others, so more lines make repeats rarer.
- Keep each line short (4 to 14 words), dry and on the user's side, with no exclamation marks, no pressure phrases ("you should") and nothing about watching or tracking.
- Run `npm test`. `test/canned.test.js` runs every line through the package's length, banned-word and persona checks.

To reset what has been shown, use **Reset line history** in Preferences.

## Adding a reaction

1. Add the name to `REACTIONS` and the rule that returns it to `reactionFor()` in `vendor/pet-brain/rules.js`. This edits a vendored file, so note the change in the file header.
2. Add at least 5 lines under that name in `canned.json`.
3. Map it to a pose in `renderer/raincloud/raincloud.json` under `reactions`.
4. Add a cooldown for it in `pet/config.js` (`cooldownMs`). Without one it uses the 30 minute default.
5. `npm test` fails until steps 2 and 3 are done, which is the point.

## Adding a pose

1. Add a row to `renderer/raincloud/raincloud.png` (16 px frames, 2 frames per row, 32 px wide) and the matching row to `raincloud@4x.png` (64 px frames).
2. Add the pose to `poses` in `raincloud.json` with the next `row` number and an `fps`.
3. Point reactions at it, or add it to the weather list in `vendor/pet-brain/weather.js`.
4. Update the row count expected in `test/petSprite.test.js` (`Math.max(...rows) + 1`). The debug cycler picks the new pose up automatically.

## Smart lines (local model, opt-in)

Off by default. In Preferences, **Smart lines: On** makes a small fine-tuned language model on the user's machine write each ambient line instead of picking one from the built-in bank. The model is `deadpan_v1_qwen3.5-0.8b-q4_k_m.gguf` (Qwen3.5-0.8B, Apache 2.0, 542 MB), run through `node-llama-cpp` 3.22.2. Nothing is downloaded and nothing leaves the machine. There is no in-app download: the file has to be put in place by hand.

How it behaves:

- **Model path.** Preferences path, then `PET_BRAIN_MODEL_PATH`, then `<user data>/models/pet-brain/<file name>`. Preferences has a path field and a Browse button. If the file is missing, Smart lines behaves as Off and the status line says "Model not installed". Only the exact expected file loads: its size and SHA-256 are checked against `vendor/pet-brain/manifest.json` once per file version, before the worker starts.
- **Lazy.** Nothing loads at launch. The first ambient line that is due starts the load in the background and is itself a built-in line. The next lines come from the model.
- **Never in the way.** While the model is not ready, the line comes back from the bank at once (about 2 ms). Inference runs in a worker thread inside the main process, never on the main thread. The renderer is a separate process.
- **Timeout and guards.** The model gets 1.5 seconds per line. A timeout, a load failure, or any failed guard (length and character rules, banned words, persona rules, contradicting the signals, a repeat, a cut-off, a second exclamation mark within 20 lines) falls back to the bank. Three failures in a row switch the model off for that brain until Smart lines is toggled or Reset line history is pressed.
- **Warm, then unload.** The model stays loaded while lines keep coming and unloads after 10 minutes without one (`MODEL_CONFIG.idleUnloadMs`), which frees about 1.5 GB. Because lines are often more than 10 minutes apart, the first line after an unload is usually a built-in line again.
- **Status line** in Preferences, refreshed every 2 seconds: model found or missing, loading, loaded or idle, and the last line's latency.
- **Debug log** (`PET_BRAIN_DEBUG=1`), one line per ambient line: `line <reaction> source=model|canned ms=<n> fallback=<reason>`. Reasons include `cold-start`, `loading`, `off`, `model-missing`, `model-mismatch`, `load-failed`, `timeout`, `invalid`, `persona`, `contradicts-signals`, `repeat`, `exclamation-rate`, `truncated`, `banned-word`, `model-error`.
- **Privacy.** The model's prompt is built only from the six coarse signals and the reaction name.

**Measured on this Mac** (Apple M4, 16 GB; full detail in `docs/PET_BRAIN_METRICS.md`): 500 synthetic events, 99.2% passed the guards, 0.8% fell back, 75% were acceptable by the three-part test (guards, length, a weak keyword on-topic check), and a manual read of 48 samples found about 71% good and 29% odd. Warm lines took 216 ms at p50 and 260 ms at p95, none hit the timeout, load took 1.4 s with the file cached and up to 6 s without, and the process used about 1.5 GB while loaded. The model's lines are fluent and mostly fit, but they are rarely dry or funny, and the package's own blind comparison found they lose to the hand-written bank. Smart lines trades some quality for variety.

## Packaging risks (report only)

Nothing below was changed. These are what a scratch `electron-builder --mac --dir` build (arm64, the repo's existing config, nothing added to `asarUnpack`) and a run of the result on this Mac showed, plus what could not be tested.

**What worked.** The build succeeded and the packaged app loaded the model and shut down cleanly (`model loaded in 5893 ms`, built-in first line, `model unloaded (shutdown)`). The package's own guide recommends unpacking `vendor/pet-brain/**` and `node_modules/node-llama-cpp/**` from the asar, but in this build that was not needed. The packaged app is 501 MB (the 864 MB build in `dist/` predates the voice removal).

- **asarUnpack.** electron-builder unpacked `@node-llama-cpp` (the `.node` addon and its dylibs) by itself. The `node-llama-cpp` JavaScript (809 files) and `vendor/pet-brain/worker.js` stayed inside `app.asar`, and the load still worked, so Electron 33's asar support covered both the ESM `import()` and the worker thread. That is a dependency on Electron's asar patching, not on a documented guarantee. A future Electron or electron-builder change, or another platform, could break it, in which case the fix is to unpack those two paths. An earlier voice experiment on this project hit `ERR_MODULE_NOT_FOUND` for ESM dependencies in the asar, so this is the first thing to look at if a packaged build ever fails to load the model.
- **Code signing.** electron-builder signed every nested Mach-O file with the existing self-signed identity, including the `.node` addon, the dylibs and the `libggml-*.so` plugins that llama.cpp loads at run time, with the hardened-runtime flag set. `codesign --verify --deep --strict` on the bundle passed. These are third-party binaries from the `@node-llama-cpp` package and ship unsigned or ad-hoc signed, so they depend on the build re-signing them. Loading worked under library validation with a self-signed identity that has no team ID, which is a lenient case.
- **Notarization.** Not possible today: the app is self-signed, with no Developer ID and no team ID. Notarizing would need Developer ID signing, a secure timestamp and the hardened runtime on all of the nested files above, and the `.so` plugins are the easiest to miss. With a real team ID, library validation requires every loaded library to carry the same team ID or be Apple's, and the entitlements may need `com.apple.security.cs.disable-library-validation` if any file is signed differently. This is untested.
- **Universal vs arm64.** The current build is arm64 only. `npm install` pulls only the matching `@node-llama-cpp/mac-arm64-metal` package (an optional dependency keyed by CPU), so an x64 or universal build from an arm64 machine would ship **without** an x64 binary. It would need the x64 package installed (for example `npm install --cpu=x64`) or a build per architecture merged with `@electron/universal`, with the native files listed as architecture-specific. Intel Macs use a CPU-only build, which is why `vendor/pet-brain/worker.js` only uses the Metal binary on Apple Silicon. Intel, universal and Windows builds are untested.
- **Size and memory.** `node-llama-cpp` adds about 69 MB to `node_modules` (43 MB of JavaScript, 18 MB of Apple Silicon binaries, plus 94 packages in all). The model file itself is not bundled. While loaded the app uses about 1.5 GB more memory.
- **Other.** `@electron/rebuild` runs during packaging and was harmless here, since `node-llama-cpp` ships prebuilt binaries. The packaged app only sees the pet brain if `PET_BRAIN_LOCAL=1` reaches it from outside.

## Weather mood (opt-in)

Off by default. In Preferences, turn on **Weather mood**, type a city, press **Find** and pick the match. No OS location permission is used.

- What is sent: only a latitude and longitude rounded to 2 decimals (about 1 km), to Open-Meteo, with no account or identifier. As with any web request, Open-Meteo can see the IP address. Pressing Find sends the typed city name to Open-Meteo's geocoder once.
- How often: once when enabled, then at most every 15 minutes. Failures are silent and the pet falls back to its normal pose.
- Live check (2026-10-30): a real request returned `current` with `weather_code`, `is_day` (0 or 1), `temperature_2m` (degrees C) and `wind_speed_10m` (km/h), plus `interval: 900`. `weather.js` assumes exactly those, so it is unchanged.
- Attribution, shown in Preferences: "Weather data by Open-Meteo.com (CC BY 4.0)".
- **Licensing**: Open-Meteo's free tier is non-commercial only. Revisit the provider or buy a plan before any paid release. The same note is in `pet/weatherService.js`.

## Tests

```
npm test
```

Uses `node --test`, no extra dependency. The suite passes with `PET_BRAIN_LOCAL` set and unset. The repo had no tests before this branch, so these are the app's whole suite. The Smart lines tests use a mocked model (timeout, bad output, missing file, wrong file, failed load, idle unload, a throwing worker) so they never need the 542 MB file. `scripts/measure-pet-brain.js` and `scripts/electron-model-check.js` are the checks that use the real model.

`test/crabFlagOff.test.js` is the flag-off regression guard. It runs `renderer/crab.js` with a seeded random generator, a fake clock and a recording canvas, hashes about 2.6 million draw calls over roughly four minutes of frames, and compares the hash with one recorded from the commit before the pet brain work (35227a8). If you change the crab's look or movement on purpose, rerun the recorder and replace the golden hash.

## Decisions made

Choices made on the owner's behalf while building this, so they can be reviewed or reversed.

1. **Voice removal is its own commit** at the base of the branch (35227a8). It was sitting uncommitted in the working tree when this started, and keeping it separate keeps the pet brain diffs reviewable. Drop that commit if it is unwanted.
2. **Vendored files.** Copied the 11 files the package lists plus `weather.js` into `vendor/pet-brain/`, and later `worker.js` and `manifest.json` for Smart lines. Left out the type declarations, `host/`, `modelStore.js` (it contains download code, and no in-app download is wanted), the package's tests and the model. Only `worker.js` is changed, see decision 21.
3. **Sprite file name.** The manifest says `raincloud@4x.png` but the file shipped as `raincloud4x.png`. Shipped it as `raincloud@4x.png`. The sprite uses the 1x sheet at a whole-number scale, so the 4x image is carried but unused.
4. **Reactions map.** Added `morning_start` to `hello` and `reading_docs` to `focus`, which the manifest lacked, and removed `returned_from_idle`, which is an event name and never a reaction. Kept `idle` in `ambientReactions` because the sprite passes `idle` when no reaction is active.
5. **Typing is an approximation.** The app has no keystroke signal and a global key hook needs Input Monitoring permission and a native module. Typing pace is the share of recent seconds with any input, so mouse activity counts too. A real source can be passed on the sample as `typing` and overrides it.
6. **Build and error events have no source.** `stuck`, `celebrate` and `error_spotted` can only be reached by pushing an event or with the pose cycler. `controller.pushEvent()` is the hook for a future shell or editor integration.
7. **Music is macOS and Spotify only.** It only talks to Spotify when it is already running. On Windows it reports `none`, because the only route is the Spotify Web API, which would be a network call.
8. **Flag semantics.** `PET_BRAIN_LOCAL=1` is the gate. The Preferences switch is a soft off beneath it. With the gate closed, Preferences shows no new section, the tray menu has no new item, and the prefs window keeps its old size.
9. **Legacy chatter goes quiet when the brain is on.** The old 25 to 45 minute idle chatter and the renderer's random idle thoughts are skipped, so the two do not double up. Battery, calendar and timer alerts, and the first-use time-of-day greeting, are unchanged.
10. **Defaults.** 30 s startup quiet, 2 min global gap, per-reaction cooldowns in `pet/config.js`, chattiness 0.5x, 1x, 2x, an evaluation every 5 s, a 10 s minimum between pose changes, an 8 s pose hold, a 7 s bubble.
11. **Fullscreen detection.** macOS reads `AXFullScreen` of the front window, which needs the Accessibility permission the app already uses for window titles, and treats failure as not fullscreen. Windows uses `SHQueryUserNotificationState` and is untested. No app-name list for presentation apps.
12. **Bubble handling.** One line in the existing single-line bubble. If a timer alert, another bubble, an open chat panel or sleep is using it, the line retries for 20 seconds and is then dropped.
13. **Sprite size.** The sprite is square, 16 px times `round(0.75 x Size setting)`, so it is about the crab's width. The pet's bounding box follows it.
14. **Toggling the master switch reloads the pet window**, so the sprite changes. The pet's position resets.
15. **Weather disclosure** names the IP address and the city-name lookup as well as the rounded coordinates, since both are true.
16. **Packaging.** Added `pet/**/*` and `vendor/**/*` to `build.files`. No `asarUnpack` change was made, including for `node-llama-cpp`: a scratch build loaded the model without one (see Packaging risks).
17. **Testing.** Added `npm test` using `node --test`. No new dependency.
18. **Smart lines plumbing.** The model service is a backend for `petBrain.js` in hybrid mode, so the package's guards and timeout are used as shipped. Because `petBrain` marks a failed model call as a failure and switches the model off after three, the service answers "not ready" with an `abort` result, which `petBrain` treats as "use a built-in line" without counting a failure. `petBrain`'s own 3 s gap between model calls is set to zero because the reaction layer already spaces lines by a minute or more.
19. **First line is built in.** Following "load lazily on the first ambient reaction" and "fall back on timeout", the line that triggers a load is a built-in line, since a load takes 1.4 to 6 s against a 1.5 s timeout. With the 10 minute unload, the first line after an unload is usually built in too. A longer unload time (`idleUnloadMs`) trades memory for more model lines. Waiting for the load before showing the first bubble would fix this at the cost of a late bubble, and was not done.
20. **CPU by default.** `MODEL_CONFIG.gpu` is `'cpu'`. Metal is about 30 percent faster (p50 151 ms against 216 ms) with the same quality, but CPU is already far inside the budget and avoids waking the GPU.
21. **One patch to the vendored worker.** `node-llama-cpp` ships no CPU-only binary for Apple Silicon, so the package's `getLlama({ gpu: false })` fails there with `NoBinaryFoundError` (checked in plain Node and in Electron). `vendor/pet-brain/worker.js` now reads `PET_BRAIN_GPU` (`cpu` or `metal`): on Apple Silicon `cpu` means the Metal binary with zero GPU layers, and everywhere else it is the original `gpu: false`. The change is marked in the file header and at the call site.
22. **The model file must be the expected one.** Its size and SHA-256 are checked against `manifest.json` before loading, so a configured path to some other GGUF is refused (status: "not the expected one"). To use a new model, update `manifest.json`. This is the package's own stated access control.
23. **The model service lives only in the main process**, in a worker thread, as the library's docs require. Tested in real Electron main: it works.
24. **Smart lines UI.** Off or On, a model path field with Browse, and a status line. The memory figure in the hint (1.5 GB) is the measured peak.
25. **The router is a fixed table**, used by the controller to choose how to build the brain. It exists so the rule is written in one place and tested, not as a runtime classifier.
26. **Measurement choices.** 500 stratified synthetic events (about 21 per reaction, signals drawn at random until the rules agree), a fresh brain per event around one shared loaded model, the app's real guards and timeout. "On topic" is a keyword overlap with the built-in lines, calibrated by scoring those lines the same way (44 percent), plus a manual read of 48 samples. Neither is a judgment of wit.
27. **Rename: the pet is "Drizzle", pet name only.** Chosen by the assistant because the owner asked for a name that is not a crab and gave none. It changes the default pet name, the dialogs, tray menu and window titles (`APP_NAME` in `main.js`). It does not change the app id, the data folder, the `mcp__clawd__` tool names, IPC channel names or the package name, so saved logins and permissions are untouched. The owner's saved `petName` was changed from clawd to drizzle in `prefs.json` (backup next to it). To use another name, change the `'drizzle'` and `'Drizzle'` defaults in `agent.js`, `main.js` and `renderer/`.
28. **The chat model is stated in the system prompt, and the species follows the sprite.** `AGENT_MODEL` in `agent.js` names the model once and the prompt tells the pet which one it is. The prompt says raincloud while the pet brain is active and crab otherwise, using `pet/flag.js`. `test/router.test.js` allows that one `pet/flag.js` use in `agent.js` and asserts the file has no requires, so the typed-message path still cannot reach the brain or the model.
29. **Drizzle sprite v2, working on `main`.** The v2 sheet work started from `main` at `dcf0e2f` (the merge of the pet brain branch), tagged `pre-drizzle-v2`. The tag is on `main`, not on the branch that was checked out, so `git reset --hard pre-drizzle-v2` on `main` returns to exactly that state. Phase commits follow the tag.
30. **Manifest merge.** `renderer/raincloud/raincloud_v2.json` is the supplied v2 manifest with only `reactions` and `ambientReactions` replaced by the app's own, which are identical to the v1 manifest's. Against the supplied defaults this adds `morning_start` (hello) and `reading_docs` (focus) and drops `returned_from_idle`, which is an event, not a reaction. `ambientReactions` did not differ. Everything else is deep-equal to the supplied file, and the supplied png, @4x png and player are byte-identical copies. The merge is `scripts/merge-raincloud-manifest.js`, so a regenerated sheet can be merged the same way.
31. **No packaging config change.** `build.files` already contains `renderer/**/*`, so the v2 files ship without an edit. This is checked against a packed build at the end (see Phase 4 notes).
32. **Player swap.** `renderer/petSprite.js` loads `raincloud_v2` (sheet, manifest, player) and picks every pose through `pet.poseFor(reaction, weatherPose)` and `pet.frameAt`, so frame counts and loop flags come from the manifest. It never assumes a global frame count. With no live reaction the reaction is `idle`, which is an ambient reaction, so the weather pose shows when nothing else is going on, as it did with v1.
33. **Who wins when.** Asleep beats everything and shows the sleepy pose. A bubble's pose (held 8 s) is drawn over the idle behavior at once, over blinks and glances too. A reaction that maps to the plain idle pose (all the ambient ones do) is never drawn as a frozen idle pose: the idle behavior (blinks, glances) carries on instead. The live reaction, which follows the rules, is handed to the player's walker and shows whenever the pet is standing still.
34. **The hidden pose cycler moved with the swap.** The v1 cycler depended on the v1 player, so it was rewritten here: it steps through every pose in the sheet, names each with its frame count, and plays the one-shot poses (`turn`, `look`) once and holds their last frame. Previewing mirrored poses comes in Phase 4.
35. **Drawing.** Every draw is nearest neighbor and the x position is snapped to the sprite pixel grid (a whole number of sprite pixels, each `round(0.75 * Size)` screen pixels, same as before). The canvas and `devicePixelRatio` handling are unchanged.

## Known gaps

- `stuck`, `celebrate` and `error_spotted` are unreachable in normal use until something pushes build and error events.
- Typing pace includes mouse activity.
- Windows is untested for the whole feature. Music reports `none` there, fullscreen detection is unverified, and the PowerShell probes are heavier than macOS ones.
- If the renderer cannot show a bubble (chat open, a timer alert up, asleep), the cooldown has already been used in the main process. Rare, and the line is simply lost.
- Weather poses show only on ambient reactions, so they appear less often than the weather changes.
- The first-use time-of-day greeting from the crab can overlap a `greeting` or `welcome_back` bubble.
- A packaged build needs the environment variable set from outside the app. There is no in-app way to open the gate.
- Smart lines: the model has to be put in place by hand (no download), the first line after launch or an idle unload is a built-in line, and about 1.5 GB of memory is used while it is loaded.
- Smart lines quality: guard-passing lines can still be odd (about 29 percent of a 48-line manual sample), and the package's own blind comparison found the built-in bank wins. The guards check rules, not wit.
- Three failures in a row switch the model off for that session's brain. A failure here is a timeout, a thrown error or an invalid line. Toggling Smart lines or pressing Reset line history starts it fresh.
- Smart lines is untested on Windows and Intel Macs, and the packaging notes above list what is unverified.
