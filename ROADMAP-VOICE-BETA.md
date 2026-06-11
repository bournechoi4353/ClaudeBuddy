# Clawd Voice — Beta Roadmap

Bringing the **C.V.A (Claude Voice Assistant)** speech backend into Clawd so the crab can
**listen and talk**. Goal: you say "hey clawd, what's the weather" and the crab perks up,
the orb-crab pulses to your voice, and he answers out loud — all local, all on your Claude
subscription.

This is a **separate track** from the main [ROADMAP.md](ROADMAP.md). It's gated: nothing here
ships until the Phase 0 spike proves the native speech runtime loads inside Clawd's Electron.

Source of the backend: `/Users/bournechoi/Documents/GitHub/C.V.A` — we lift the *backend*
(STT, TTS, wake word, streaming pipeline) and **drop its React HUD**. Clawd's pixel crab
replaces C.V.A's orb.

---

## What we're taking from C.V.A vs leaving behind

**Take (backend):**
- `src/main/tts.ts` — Kokoro neural TTS (local, ~90MB, `af_heart` voice).
- `src/main/pipeline.ts` — streaming turn: Claude deltas → sentence split → per-sentence
  Kokoro → audio. The latency win.
- `src/main/stt.ts` + `src/main/stt-worker.mjs` — Moonshine STT in a system-Node sidecar.
- `src/renderer/src/wake.ts` + `src/shared/wake-detect.mjs` — VAD + wake-phrase matching.
- `src/renderer/src/ttsPlayback.ts` — gapless Web Audio queue + amplitude.
- `src/renderer/src/audio.ts` — mic capture → mono 16kHz Float32 + live level.
- `src/main/fastpath.ts` + `src/shared/intents.mjs` — optional local fast path (time/timer/weather).

**Leave behind (UI/appliance):**
- The whole React HUD (`components/`, `App.tsx`, Zustand store, styles).
- Fullscreen kiosk mode, start-at-login appliance behavior.
- The orb — **the crab is the orb.**

**Reuse from Clawd:**
- `agent.js` already streams `{type:'chunk'}` deltas — the pipeline sits on top of it.
- `renderer/crab.js` already has `setListening` (sway) and `dance` (amplitude bob) — wire
  mic level → listening, TTS amplitude → speaking.
- Subscription auth, the existing tool set, prefs system, tray.

---

## Known constraints (read before greenlighting)

1. **Electron version gap.** C.V.A runs Electron **42**; Clawd runs **33**. C.V.A verified
   native ONNX loads on 42, *not* 33. Phase 0 settles this. Likely outcome: bump Clawd to
   Electron 42 (own risk — re-test transparent click-through window, the SDK Bun-binary
   spawn, tray, multi-monitor).
2. **Bundle size.** `onnxruntime-node` is ~210MB on disk; models ~150MB. Clawd is already
   ~400MB. Voice build could approach **~700MB**. Decision recorded below: voice is an
   **opt-in feature**, not forced into the base download.
3. **System Node dependency.** The STT sidecar needs `node` on PATH. Either require it
   (breaks "just works" install) or bundle a Node runtime. Tracked in Phase 2.
4. **Click-through window can't get key events.** No "hold spacebar to talk." Push-to-talk
   needs `globalShortcut`; hands-free wake is the natural primary input for a pet.
5. **Always-on mic = CPU + battery + privacy.** Continuous VAD on an always-on-top window.
   Needs an explicit toggle, a visible "listening" indicator, and an off state.
6. **Latency vs capability.** C.V.A uses Haiku + only WebSearch for snappy voice. Clawd's
   value is Sonnet + ~27 tools. Decision recorded below.
7. **macOS first.** C.V.A is mac-only (Kokoro/Moonshine, osascript). Voice is mac-first;
   Windows degrades to text like the other mac-only tools. Guard with `platform.IS_MAC`.

---

## Decisions to lock before Phase 1 (fill in on review)

- [ ] **D1 — Install philosophy:** voice bundled by default (~700MB app) **or** opt-in
      "Enable Voice" download fetched on first toggle? *(recommendation: opt-in)*
- [ ] **D2 — Voice model:** fast (`claude-haiku-4-5`, trimmed tools) **or** full Clawd brain
      (`claude-sonnet-4-6`, all tools, ~2–4s replies)? *(recommendation: Sonnet + all tools —
      a pet that can drive Spotify/Calendar by voice is the whole point; accept the latency)*
- [ ] **D3 — Primary input:** hands-free wake word **or** push-to-talk hotkey first?
      *(recommendation: TTS-only first (no input), then hands-free)*
- [ ] **D4 — Electron bump:** bump Clawd 33 → 42 up front, or only if Phase 0 forces it?
      *(recommendation: only if Phase 0 segfaults on 33)*

---

## Phase 0 — Native runtime spike (GATE) ✅ PASSED

The cheap make-or-break test. **Result: PASS** — Kokoro's native ONNX runtime loads and runs
under Clawd's **Electron 33** (Node 20.18.3), no `SIGSEGV`. **D4 resolved: no Electron 42 bump
needed.**

Measured (`voice/spike.js`, throwaway Electron main, played via `afplay`):
- `kokoro-js@1.2.1` → `onnxruntime-node@1.21.0` (napi-v3, darwin/arm64 prebuilt) loaded clean.
- Model: 13.5s first-run (incl. ~90MB download, cached after); synth 1.79s for 3.9s of 24kHz audio.
- Adds ~237MB to `node_modules` (onnxruntime-node 208MB + kokoro-js 29MB). Base Clawd is
  unaffected until `main.js` actually imports it (it doesn't yet).

**Still unproven (close out during Phase 1):**
- SDK Bun-binary spawn coexisting with in-process ONNX in the *same* running app (low risk —
  the Bun binary is a separate subprocess, not an in-process native binding, so no ORT/ORT
  collision; verify anyway).
- Packaged `asarUnpack` reaching the `.node` files + how the Kokoro model ships in the `.app`
  (module-relative cache, per C.V.A) — this is the D1 install-size decision in practice.

**Files:** `package.json` (added `kokoro-js`), `voice/spike.js` (throwaway — safe to delete).

---

## Phase 1 — Clawd speaks (TTS out) ✅ BUILT (pending your listen-test)

**Done & installed.** Tray → **Speak replies** (off by default). When on, Clawd speaks his
typed answers; the crab bobs/mouths along to his own voice amplitude. Kokoro is lazy-loaded on
first spoken reply (one-time ~13s + ~90MB download to `userData/voice-models`), so base startup
is untouched when off.

**Implemented:**
- `voice/tts.js` — Kokoro wrapper (lazy load, LRU cache, model cache redirected to a writable
  `userData` dir so a packaged `/Applications` build can download on first use).
- `voice/pipeline.js` — sentence-split streaming + first-clause early-speak, on Clawd's existing
  agent chunk stream.
- `renderer/ttsPlayback.js` — gapless Web Audio queue → `Crab.setSpeakingLevel` → mouth-along bob.
- `renderer/crab.js` — `setSpeaking`/`setSpeakingLevel` + `speakY` draw offset.
- `main.js` — autoplay switch, chunk→speaker tap in `chat-send`, barge-in stop on new turn,
  tray toggle (warms the model on enable).
- `package.json` — `voice/**` bundled; `onnxruntime-node` + `kokoro-js` asarUnpacked.

**D1 reality check:** packaged app is now **~871MB** (onnxruntime ships every platform's
binaries). Confirms opt-in matters; revisit trimming/pruning foreign-arch ONNX binaries or a
separate-download model before any wide release.

**Closed the Phase 0 leftovers:** native ONNX coexists fine with the SDK Bun binary in one
running app; packaged `asarUnpack` reaches the `.node` files; verified the app launches clean
with voice wired in.

### Original scope (for reference)

Highest delight-to-risk ratio. No mic, no sidecar, no permissions. Shippable on its own.

**Scope:**
- Port `pipeline.ts` sentence-split onto Clawd's existing `agent.js` chunk stream: as deltas
  arrive, split on sentence boundaries, synthesize each with Kokoro, emit audio over IPC.
- First-clause early-speak (cut the opening clause at a comma) so a long first sentence
  doesn't bottleneck first-audio.
- Renderer plays gapless audio (`ttsPlayback.ts`) and feeds amplitude → crab `dance`/bob so
  **the crab visibly mouths along** to his own voice.
- Tray toggle: **Voice replies: on/off**, persisted in prefs.
- Strip URLs/markdown before speaking (C.V.A's `speakable()`).

**Decision dependencies:** D1 (where the model lives), D2 (which model — affects latency feel).

**Files:** `agent.js` (or new `voice/pipeline.js`), `voice/tts.js`, `preload.js` (audio IPC),
`renderer/chat.js` + `renderer/crab.js` (playback + amplitude animation), `main.js` (autoplay
switch, tray toggle), `package.json`.

---

## Phase 2 — Clawd listens (push-to-talk STT) ✅ BUILT (pending your mic test)

**Done & installed.** Trigger is a **mic button in the chat panel** — NOT a keyboard shortcut.
(The global-shortcut approach was dropped: `globalShortcut` is key-down-only, the click-through
window can't reliably own a hotkey, and every rare combo collided with something on the user's
machine.) Flow: tap the crab to open chat → tap the mic button → crab listens (pulses to your
voice) → tap the mic again (or ~12s auto-stop) → the utilityProcess transcribes → the transcript
is injected through the existing chat path (so the Kokoro reply + TTS already fire on the answer).
First mic tap requests mic permission and warms the Moonshine worker (first-ever use downloads
~250MB). Nothing downloads until you tap the mic — STT is opt-in by action.

**Implemented:**
- `voice/stt-worker.mjs` — Moonshine ASR in an Electron `utilityProcess` (bundled Node, isolated ORT).
- `voice/stt.js` — main-process worker manager (fork, keep-warm, respawn, `transcribe()`); passes
  the userData model-cache dir via fork `env`.
- `renderer/audio.js` — mic capture (mono 16kHz Float32 + amplitude → crab listening), 12s auto-stop.
- `renderer/chat.js` — factored `submit()` (shared by typing + STT) + `systemNote()` for mic errors.
- `main.js` — session media-permission handlers, `mic:request` + `stt:transcribe` IPC, `globalShortcut`
  TOGGLE (register/unregister on the tray toggle and on quit), PTT state sync.
- `preload.js` — `onPtt` / `transcribe` / `pttEnded`.
- `package.json` — `NSMicrophoneUsageDescription`; **asarUnpack widened to `node_modules/**`** (see below).

**Both packaged unknowns closed:**
- Moonshine loads + transcribes in the utilityProcess (proven in the Phase 2.0 spike).
- Packaged `app.asar.unpacked` resolution works — verified by forking the INSTALLED app's worker and
  transcribing "set a timer for ten minutes" → "Set a timer for 10 minutes." (worker ready 5.3s cached).

**Packaging gotcha found + fixed:** ESM `import` (transformers' `.node.mjs`) does NOT redirect into
asar like CommonJS `require` does, so unpacking only `@huggingface/transformers` left its ESM deps
(`onnxruntime-common`, `sharp`, jinja…) unresolvable → `ERR_MODULE_NOT_FOUND`. Fix: asarUnpack
`**/node_modules/**` so packaged ESM resolution matches dev. (Same total size — asar just moves to
unpacked; app ~864MB.) No new npm dependency; no Electron bump.

### Architecture decided + spiked ✅ (2026-06-11)

A 4-agent design pass + a TTS→STT round-trip spike settled the architecture. **Decision:
run Moonshine STT in an Electron `utilityProcess` child — NOT C.V.A's system-Node sidecar.**

Why: C.V.A's sidecar exists only to avoid two onnxruntime bindings colliding in one process
(a SIGSEGV). That collision was a *duplicate-dependency artifact* in C.V.A (it pinned
`@huggingface/transformers@4.x` directly while kokoro-js wanted `3.x` → npm installed two
copies → two native ORTs). **Clawd doesn't have it**: it declares only kokoro-js, so npm
deduped to ONE `@huggingface/transformers@3.8.1` + ONE `onnxruntime-node@1.21.0`, which
kokoro-js itself uses. A `utilityProcess` gives STT its own process (Electron's *bundled*
Node — no system Node) so the ~250MB model download + inference never blocks main's agent
loop, the tray, the TTS pipeline, or the crab.

**Spike result (TTS→STT round trip, throwaway):** Kokoro synthesized "what is the weather in
tokyo today" in MAIN, resampled 24k→16k, Moonshine in a `utilityProcess` child transcribed it
back as "What is the weather in Tokyo today?" — **model load 0.7s (cached), transcribe 0.07s,
exit 0.** Proves: bundled-Node child, no ORT collision (two ORTs/two processes), moonshine
loads+runs+is accurate, `parentPort` IPC works.

**Gotchas captured for the real build:**
- `utilityProcess.postMessage(msg, [transfer])` transfer-list accepts ONLY `MessagePortMain`,
  NOT `ArrayBuffer`s (unlike web Workers) — send audio by structured-clone copy (a clip is
  only a few hundred KB).
- The child can't call `app.getPath()` — pass the userData model-cache dir via `fork`'s
  `env` (e.g. `STT_CACHE_DIR`); the worker sets transformers `env.cacheDir` before `pipeline()`.
- Deps already installed; only add `@huggingface/transformers/**` to `asarUnpack` and the new
  worker file to `build.files`. `moonshine-base-ONNX` q8 ~250MB downloads to userData on first use.
- **No new npm dependency.** No Electron bump.

**Still to verify in the build:** packaged-asar path resolution of the ORT binding inside the
child; whether `sharp` (a transformers image dep) must ship; and that mic TCC persists across
re-packs under the stable self-signed cert.

### PTT UX (decided)
`globalShortcut` is key-DOWN-only and the click-through window is unfocused (no key events), so
literal hold-to-talk is impossible without a rejected native key-hook dep. → **press-to-start /
press-to-stop TOGGLE**, default `CmdOrCtrl+Shift+Space`, with a ~12s safety auto-stop so the mic
never stays hot. On start: crab enters listening + pulses to mic level; on stop: transcript is
injected through the existing `chat-send` path so the Kokoro reply loop already fires.

### Build scope (original)

Bring in the mic. Test the system-Node sidecar dependency in isolation.

**Scope:**
- `globalShortcut` (e.g. `Cmd+Shift+Space`): hold → capture mic, release → transcribe →
  send as a chat turn. Works regardless of the click-through window's focus.
- Port `audio.ts` (mic → mono 16kHz Float32 + live level) and `stt.ts` + `stt-worker.mjs`
  (Moonshine sidecar).
- macOS mic permission flow (`systemPreferences.askForMediaAccess('microphone')`). Note: like
  Screen Recording, mic TCC persists across rebuilds thanks to the stable self-signed cert.
- While listening: crab enters `setListening` sway + pulses to mic amplitude.
- Resolve the system-Node question (D-follow-up): require it with a clear error, or bundle a
  Node runtime for the sidecar.

**Files:** `main.js` (globalShortcut, mic IPC, permission), `voice/stt.js`, `voice/stt-worker.mjs`,
`renderer/audio.js`, `renderer/crab.js` (listening animation), `platform.js` (mac guard).

---

## Phase 3 — Hands-free wake word ✅ BUILT (pending your mic test)

**Done & installed.** Tray → **Hands-free (say 'clawd')** (off by default). When on, Clawd keeps
an always-on energy-gated VAD mic; each spoken utterance is transcribed locally by the Moonshine
worker and fuzzy-matched against "clawd"/"claude"/"hey clawd". Say "clawd, what's the weather" →
he perks up (hop + listen sway) and answers. Say a bare "clawd" → he chimes and arms an ~8s window
where your next sentence is taken as the command directly (no re-wake).

**Implemented:**
- `renderer/wake.js` — continuous VAD (ported from C.V.A wake.ts, retuned) + inlined wake-detect
  (variants for clawd/claude + Levenshtein fuzzy match + noise filter), as a classic script (no ESM).
- Reuses the Phase 2 `stt:transcribe` worker — no new STT machinery.
- Coordination: wake ignores captured audio while Clawd is speaking (`ClawdVoice.isSpeaking`),
  a turn is in flight (`Chat.isBusy`), or the push-to-talk mic button is capturing — so he never
  wakes himself or double-captures.
- `renderer/crab.js` — `wakePerk()` (hop + brief listen sway on wake).
- `main.js` — tray toggle, `clawd-hands-free` IPC, mic prompt + STT warm on enable, re-arm on
  startup after `did-finish-load`.
- `preload.js` — `onHandsFree`.

**Tradeoffs (by design):** always-on mic when enabled (OS mic indicator stays on), continuous
local transcription (CPU), local-only + opt-in + off by default. Wake word is "clawd" OR "claude".

**Still needs your mic test:** real wake detection accuracy/false-wakes in a room, and whether the
echo-cancel + speaking-guard reliably stops Clawd waking himself.

### Original scope

The "wow." Always-on, say "hey clawd" from across the room.

**Scope:**
- Port `wake.ts` continuous VAD + `wake-detect.mjs` fuzzy matching, retuned for "clawd"
  (and "crab"?) instead of "claude".
- Speculative early transcription at ~256ms silence so wake is confirmed by endpoint time.
- Follow-up listening: if Clawd ends a reply with a question, keep the mic armed ~12s.
- Visible always-listening indicator on the crab + a hard off switch in the tray.
- Privacy copy: explicit, local-only, opt-in. Off by default.

**Files:** `renderer/wake.js`, `shared/wake-detect.mjs`, `renderer/crab.js` (wake indicator),
`main.js` (wake lifecycle, tray), prefs.

---

## Phase 4 — Optional: local fast path 

Port `fastpath.ts` + `intents.mjs` so "what time is it" / "set a 10 minute timer" /
"what's the weather" answer locally in ~1s, skipping the Claude round trip. Clawd already has
timer + weather tools, so this is mostly wiring the parser to the existing handlers. Lowest
priority — pure latency polish.

---

## Open questions

- Wake word: keep "claude", switch to "clawd", or accept both? (Fuzzy matcher needs retuning.)
- Does voice run on the *same* SDK session as typed chat (shared memory) or a separate one?
  Shared is nicer but couples the model/tool choice (D2) across both input modes.
- Barge-in: press/tap the crab while he's talking to cut him off and start a new turn
  (C.V.A has this) — worth porting in Phase 2.
- Windows voice: out of scope for beta, or minimal Whisper-based path later?

---

## Success criteria for "beta done"

1. Say "hey clawd, what's the weather in Tokyo" → crab perks up, pulses to your voice, and
   speaks the answer, all local, < a few seconds to first audio.
2. Voice is opt-in and clearly toggleable; off by default; mic state always visible.
3. Base (non-voice) Clawd install is unchanged in size and behavior.
4. macOS solid; Windows degrades gracefully to text.
