# Pet brain

An optional layer that gives the desktop pet a small personality of its own. It is off by default, lives on the `ml-pet-brain` branch, and when it is off the app behaves exactly as it did before.

What it does when on:

- The pet becomes a raincloud (a new original sprite) instead of the crab.
- It watches coarse signals (which kind of app is in front, how long you have been idle, the time of day, whether Spotify is playing) and picks a reaction with deterministic rules.
- It shows one short line from a hand-written bank for that reaction, and a matching pose.
- Optionally, it matches the weather when idle.

Nothing here reads window titles, URLs, document names, screenshots or keystroke content. The whole thing runs on the user's machine. The only network request is the opt-in weather lookup.

## Running it

```
PET_BRAIN_LOCAL=1 npm start
```

From VS Code's terminal, also strip the inherited variable: `env -u ELECTRON_RUN_AS_NODE PET_BRAIN_LOCAL=1 npm start`.

| Variable | Effect |
|---|---|
| `PET_BRAIN_LOCAL=1` | Opens the gate. Off by default, and only the exact value `1` counts. |
| `PET_BRAIN_DEBUG=1` | Logs every reaction decision, block reason, pose change and weather pose to the console as `[pet-brain] ...`. |

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
| `pet/weatherService.js` | Opt-in weather. Does nothing until enabled and given a place. |
| `pet/prefs.js` | Validation of the pet brain's own preferences. |
| `vendor/pet-brain/` | The pet brain package, unmodified: `rules.js`, `petBrain.js`, line and persona checks, `canned.json`, and `weather.js`. |
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

Uses `node --test`, no extra dependency. The suite passes with `PET_BRAIN_LOCAL` set and unset. The repo had no tests before this branch, so these are the app's whole suite.

`test/crabFlagOff.test.js` is the flag-off regression guard. It runs `renderer/crab.js` with a seeded random generator, a fake clock and a recording canvas, hashes about 2.6 million draw calls over roughly four minutes of frames, and compares the hash with one recorded from the commit before the pet brain work (35227a8). If you change the crab's look or movement on purpose, rerun the recorder and replace the golden hash.

## Decisions made

Choices made on the owner's behalf while building this, so they can be reviewed or reversed.

1. **Voice removal is its own commit** at the base of the branch (35227a8). It was sitting uncommitted in the working tree when this started, and keeping it separate keeps the pet brain diffs reviewable. Drop that commit if it is unwanted.
2. **Vendored files.** Copied the 11 files the package lists plus `weather.js`, unmodified, into `vendor/pet-brain/`. Left out the type declarations, `worker.js`, `host/`, `modelStore.js`, the package's tests and the model.
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
16. **Packaging.** Added `pet/**/*` and `vendor/**/*` to `build.files`. Canned-only mode needs no `asarUnpack`.
17. **Testing.** Added `npm test` using `node --test`. No new dependency.

## Known gaps

- `stuck`, `celebrate` and `error_spotted` are unreachable in normal use until something pushes build and error events.
- Typing pace includes mouse activity.
- Windows is untested for the whole feature. Music reports `none` there, fullscreen detection is unverified, and the PowerShell probes are heavier than macOS ones.
- If the renderer cannot show a bubble (chat open, a timer alert up, asleep), the cooldown has already been used in the main process. Rare, and the line is simply lost.
- Weather poses show only on ambient reactions, so they appear less often than the weather changes.
- The first-use time-of-day greeting from the crab can overlap a `greeting` or `welcome_back` bubble.
- A packaged build needs the environment variable set from outside the app. There is no in-app way to open the gate.
