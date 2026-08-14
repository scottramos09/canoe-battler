Below is the complete, self-contained concept document. It is written so an implementation agent can pick it up cold: numbered sections are referenceable (§), contracts are typed, phases have gate criteria instead of dates.

---

# Three.js Agent Bridge (TJAB) — Concept & Engineering Specification

**Document purpose:** This is the authoritative spec for building TJAB, a system that gives any AI agent full observation and control of Three.js applications running in a browser. An implementing agent should build in the phase order in §16 and not advance past a phase gate until its criteria pass.

**Normative language:** MUST / SHOULD / MAY are used per RFC 2119.

---

## 1. Problem Statement

Three.js renders into a `<canvas>`. Every mainstream agent tooling stack (DOM inspection, accessibility trees, CSS selectors) sees only that one element. As a result, agents cannot test, play, or operate web 3D content the way a human does — by looking at the screen and acting on it.

TJAB solves this by instrumenting the Three.js runtime with an in-page bridge that exposes three channels to external agents:

1. **Symbolic channel** — structured read/write access to the scene graph, objects, camera, renderer state, and performance counters.
2. **Visual channel** — pixel-identical frame capture of what a human would see, plus an object-ID segmentation pass and depth.
3. **Control channel** — input synthesis, camera manipulation, deterministic time control, reflex policies, and replay.

## 2. Design Principles

- **P1 — Symbolic first, vision for verification.** Structured queries answer most questions; frames confirm. Never require vision where a scene query suffices.
- **P2 — Human-equivalent view.** RGB capture MUST be the exact pixels composited to the canvas.
- **P3 — Determinism on demand.** The system MUST be able to pause, step, seed, and replay a run so tests are reproducible.
- **P4 — Nothing missed.** A ring buffer MUST record frames + events so an agent can inspect any past moment regardless of its own decision latency.
- **P5 — Engine-agnostic core.** The bridge contract (§8) is engine-neutral; Three.js is the first adapter.
- **P6 — Zero app redesign.** Instrumentation MUST be ≤ 3 lines of app code (Mode A) or achievable without app changes where feasible (Mode B).

## 3. Goals & Non-Goals

**Goals**
- Full observation/control of any Three.js app for testing, gameplay, feature verification, content iteration, and synthetic data capture.
- Protocol-agnostic surface: MCP, JSON-RPC/WebSocket, HTTP.
- Black-box ("human view") and hybrid ("human view + ground truth") operation.
- Deterministic record/replay of runs, including human-recorded runs.
- CI-capable headless operation.

**Non-Goals**
- Supporting non-browser runtimes (desktop engines) — adapters MAY come later.
- Providing the agent's own reasoning/policy intelligence — TJAB is the substrate, not the brain.
- Guaranteeing determinism for app behavior driven by network/server state or unseeded third-party RNG (§10.4 documents the boundary).

## 4. System Architecture

```
┌────────────────────────────────────────────────────────────┐
│  AI Agent (LLM loop, CI runner, RL harness)                │
└──────┬───────────────────┬──────────────────┬──────────────┘
       │ MCP (stdio/SSE)   │ JSON-RPC / WS    │ HTTP (optional)
┌──────▼───────────────────▼──────────────────▼──────────────┐
│  tjab-server (Node)                                        │
│   • session manager (browser pool)                         │
│   • command router / batching / auth                       │
│   • stream relay, trace store, golden-image store          │
└──────┬─────────────────────────────────────────────────────┘
       │ Playwright / CDP (persistent context per session)
┌──────▼─────────────────────────────────────────────────────┐
│  Browser page                                              │
│   ┌─────────────────────┐   ┌───────────────────────────┐  │
│   │ Three.js app        │◄──┤ tjab-bridge (in-page SDK) │  │
│   │ renderer/scene/cam  │   │ window.__THREE_AGENT__    │  │
│   └─────────────────────┘   └───────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

### 4.1 Repository layout

```
tjab/
├─ packages/
│  ├─ bridge/          # in-page SDK; browser-only; zero runtime deps; three as peer
│  ├─ server/          # Node orchestrator + MCP server + WS/HTTP gateways
│  ├─ cli/             # tjab CLI (record, replay, test, trace export)
│  └─ test-runner/     # deterministic suite runner for CI
├─ examples/
│  ├─ cube-scene/      # minimal instrumented scene
│  └─ platformer/      # sample game used by phase gates
└─ docs/
```

TypeScript throughout. `bridge` ships ESM + UMD and MUST work injected via `addInitScript` with no import step.

## 5. Instrumentation Modes

| Mode | Mechanism | Guarantees |
|---|---|---|
| **A — SDK attach** | App calls `attach(renderer, scene, camera)` | Full feature set. REQUIRED for phases ≥ P2 gate demos unless B works. |
| **B — Auto-discovery** | Server injects an init script that wraps `WebGLRenderer.prototype.render` before app code; first render call registers `(renderer, scene, camera)` | Works when the hook installs before the app's Three.js module initializes. Server MUST probe capability and report `bridge.source: "auto"`. |
| **C — Uninstrumented fallback** | Vision + `page.evaluate` exploration only | Degraded: capture via compositor screenshots, queries via heuristic globals. MUST be explicitly flagged `degraded: true` in session status. |

**Mode A contract:**

```ts
// app code
import { attach } from "@tjab/bridge";
attach(renderer, scene, camera, { ringBuffer: { frames: 300 } });
```

`attach` MUST:
1. Create the bridge singleton at `window.__THREE_AGENT__`.
2. Dispatch `CustomEvent("tjab:ready")` on `window`.
3. Accept an optional second `(renderer, scene, camera)` registration later (multi-viewport apps), addressable by `viewportId`.

## 6. Session Model

- **Session** = one browser context + page + bridge binding. Fields: `id`, `url`, `mode` (`blackbox|hybrid`), `bridgeSource` (`sdk|auto|none`), `capabilities`, `createdAt`.
- The server MUST keep sessions persistent across commands and support ≥ 4 concurrent sessions per worker process.
- Session lifecycle: `session.new → session.attach (navigate + wait for tjab:ready, timeout configurable) → ...commands... → session.close`.
- Crash policy: on page crash or bridge disconnect, the server MUST mark the session `detached`, attempt re-navigation + re-attach once, then surface `SESSION_LOST`.

## 7. Wire Protocol

JSON-RPC 2.0 in three transports:

| Transport | Consumers | Notes |
|---|---|---|
| MCP (stdio + streamable HTTP) | MCP-capable LLM clients | Tool mapping in §8 |
| WebSocket JSON-RPC | Custom agents, CLI | Binary frames interleaved for streams (§12) |
| HTTP POST | Simple integrations | One-shot commands only |

**Request:**
```json
{ "jsonrpc": "2.0", "id": 42, "method": "object.set",
  "params": { "session": "s1", "id": "uuid-1", "patch": { "visible": false } } }
```

**Batching:** `method: "batch"`, `params: { commands: [ ... ] }` — commands execute sequentially in-page, single round trip; response is an array of results aligned by index. MUST be atomic per command (a failed command returns its error object but does not abort the batch unless `stopOnError: true`).

**Streaming:** Server pushes notifications `method: "stream.frame"` / `stream.event` with a `streamId` (§12).

**Error taxonomy** (typed `error.data.code`): `BRIDGE_NOT_FOUND`, `OBJECT_GONE`, `VIEWPORT_GONE`, `TIMEOUT`, `POLICY_FAULT`, `CODE_DISABLED`, `SESSION_LOST`, `DEGRADED_MODE`.

## 8. Command Reference

All commands are namespaced methods on the bridge dispatcher: `dispatch(method, params) → Promise<result>`. The MCP server exposes one tool per command group; results that contain images use MCP image content blocks.

### 8.1 Scene
| Method | Params | Returns |
|---|---|---|
| `scene.graph` | `depth?, viewportId?` | Node tree (§9.1) |
| `scene.find` | `{type?, name?, visible?, hasMaterial?}` | `[{id,name,type}]` |
| `scene.diff` | `since?: snapshotId` | `{added, removed, changed[]}`; bridge keeps last snapshot per session |

### 8.2 Objects
| Method | Params | Notes |
|---|---|---|
| `object.get` | `id, props?: ["worldPos","bounds","material",...]` | Full prop pack by default |
| `object.set` | `id, patch` | Patch keys: `position, rotation, scale, quaternion, visible, name, material.color, material.map(url), castShadow` — unknown keys rejected with typed error |
| `object.add` | `{gltfUrl? | primitive, parent?, transform?}` | GLTF via loader; primitive ∈ box/sphere/plane/light |
| `object.remove` | `id` | |
| `object.focus` | `id` | Centers camera on object bounds |

### 8.3 Camera & Capture
| Method | Params | Notes |
|---|---|---|
| `camera.set` | `{position?, target?, fov?, projection?}` | |
| `camera.fit` | `id | "scene"` | |
| `capture.rgb` | `{width?, height?, format?: "png"|"jpeg", quality?}` | §9.2 |
| `capture.id` | same | Object-ID segmentation pass + `idIndex` (§9.3) |
| `capture.depth` | same | Linearized depth, grayscale |
| `capture.stream.start` | `{fps, width, format}` → `streamId` | §12 |
| `capture.stream.stop` | `streamId` | |

### 8.4 Input
| Method | Params | Notes |
|---|---|---|
| `input.click` | `{id? \| x,y, button?, modifiers?}` | If `id`: project object world position to screen (§11.1). If `x,y`: optional `raycast: true` returns the hit object(s) in the result |
| `input.move` / `input.drag` | `{from, to, steps?, durationMs?}` | Smoothed path to mimic human motion |
| `input.keys` | `{sequence: ["KeyW","Space"], holdMs?}` | Uses physical `code` values |
| `input.hold` / `input.release` | `{key \| button}` | For continuous movement |
| `input.gamepad` | `{index, buttons: {i: value}, axes: [..]}` | Requires gamepad spoof module (§14) |

### 8.5 Time & Determinism
| Method | Params | Notes |
|---|---|---|
| `time.takeControl` | `{intercept: "auto"}` | Takes over the animation loop (§10) |
| `time.pause` / `time.resume` | | |
| `time.step` | `{frames?, dt?}` | Advance exactly N frames; default dt = app's nominal frame delta |
| `time.scale` | `{factor}` | 0 < factor; slow-motion/fast-forward while agent thinks |
| `time.seed` | `{rng: number}` | Installs seeded PRNG shim (§10.3) |
| `time.now` | | `{frame, t, scaled}` |

### 8.6 Policies (reflex layer) — §13
`policy.attach {name, trigger, code, enabled?}` · `policy.remove {name}` · `policy.list` · `policy.set {name, enabled}`

### 8.7 Record & Replay — §15
`record.start {includeFrames?}` · `record.stop → recordingId` · `record.save → path`
`replay.run {recordingId, untilFrame?}` · `replay.branch {recordingId, atFrame}` (playback to frame, then hand control to agent) · `replay.last {seconds}` (ring buffer query) · `replay.export {range?} → trace file`

### 8.8 Runtime & Telemetry
| Method | Notes |
|---|---|
| `eval.js {code}` | Executes with `{scene, camera, renderer, THREE, tj}` in scope. MUST be gated by server config `allowCode` (default: allow on localhost sessions, deny remote). |
| `perf.report` | `renderer.info.render/memory`, measured FPS, frame-time histogram |
| `console.tail {n}` / `errors.tail {n}` | Buffered page console |
| `audio.level` / `audio.spectrum` | Requires audio tap (§14) |
| `wait.for {condition, timeoutMs}` | Condition grammar: `"object:<name> exists"`, `"object:<id>.position.y > 2"`, `"fps > 30"`, `"event:<type>"`, or policy-style JS predicate. Bridge resolves via rAF polling; returns when true or `TIMEOUT`. |
| `render.set {quality?, wireframe?, overdraw?}` | Quality presets mutate pixelRatio/shadows/AA flags |

## 9. Data Formats

### 9.1 Scene node
```ts
interface Node {
  id: string;            // object.uuid — stable identity across commands
  name: string; type: string; visible: boolean;
  transform: { pos: [number,number,number];
               rot: [number,number,number];     // Euler XYZ
               scale: [number,number,number] };
  bounds?: { min: vec3; max: vec3 };            // world-space Box3, meshes only
  mesh?: { vertices: number; triangles: number; material?: string };
  light?: { kind: string; intensity: number; color: string };
  children?: Node[];
}
```

### 9.2 Capture result
```ts
interface Capture {
  data: string;            // base64
  mimeType: "image/png" | "image/jpeg";
  width: number; height: number;
  frameIndex: number;      // bridge frame counter — joins frames to events
  viewportId: string;
  idIndex?: Record<string, { name: string; type: string }>; // capture.id only
}
```

### 9.3 Object-ID pass semantics
Each mesh renders with a flat unique color encoding its index; result includes `idIndex` mapping index → object. Agent MAY resolve any pixel to an object. MUST restore original materials atomically after capture, even on error.

### 9.4 Event log entry (ring buffer & traces)
```ts
interface EventEntry {
  frame: number; t: number;   // bridge clock
  type: "input" | "collision" | "policy" | "log" | "error" | "custom" | "frame";
  payload: unknown;           // e.g. {key:"Space", phase:"down"} or collision pair ids
}
```

### 9.5 Trace file (`*.tjab.json`, versioned)
```json
{ "version": 1, "seed": 1234, "nominalDt": 16.67,
  "inputs": [{ "frame": 120, "type": "key", "code": "Space", "phase": "down" }],
  "keyframes": [{ "frame": 0, "jpeg": "..." }, { "frame": 600, "jpeg": "..." }],
  "events": [ /* EventEntry[] */ ] }
```

## 10. Deterministic Time Control

### 10.1 Loop takeover
`time.takeControl` MUST neutralize the app's own loop and route it through the bridge scheduler:
- If the app used `renderer.setAnimationLoop`, replace with bridge callback.
- Otherwise patch `requestAnimationFrame` (captured before app code in Mode B; runtime-patch in Mode A) so callbacks queue into the bridge; the bridge decides when to run them.
- `time.step` advances exactly N queued frames with fixed `dt`; `time.scale` multiplies the delta passed to app code while keeping frame cadence.
- Any `THREE.Clock` instances created after attach MUST be intercepted (prototype wrap of `getDelta`) so app-side elapsed time follows bridge time.

### 10.2 Frame counter
The bridge maintains a monotonically increasing `frameIndex` incremented per executed frame. All events, captures, and trace entries join on it.

### 10.3 RNG seeding
`time.seed` installs a seeded mulberry32 shim over `Math.random` and exposes `tj.rand()` for app opt-in. Documented boundary: app-side custom PRNGs (e.g., library-internal) are NOT covered unless the app routes them through `tj.rand()`.

### 10.4 Determinism boundary (normative note)
Determinism applies to client-side simulation. Networked state, `Date.now()`-driven logic, and worker timing remain nondeterministic; the test runner MUST flag suites that touch them via `perf.report.heuristics` (detect `WebSocket`/`fetch` activity during run).

## 11. Input Synthesis Details

### 11.1 Symbolic click
For `input.click {id}`: compute object world position (or bounds center), `project(camera)` to NDC, convert to canvas CSS pixels accounting for bounding rect and devicePixelRatio, then dispatch. If the object is off-screen or occluded, return `{clicked: false, reason}` with the option `forceRaycast: true` to click its screen position regardless.

### 11.2 Event fidelity
Pointer sequences MUST emit `pointerover → pointerenter → pointermove → pointerdown → (pointerup → click)` with correct `isPrimary`, `button`, `pointerType: "mouse"`, and coordinates in both client and offset space. Keyboard events MUST populate `code`, `key`, `repeat`, and target the focused element. Apps listening on `window`, `document`, or the canvas MUST all receive events (dispatch at the deepest target; bubbling covers the rest).

### 11.3 Human-likeness options
Drags and moves accept `steps` and `durationMs` for interpolated paths with slight easing; a `jitter` option adds sub-pixel noise. (Anti-bot realism is not a goal; QA realism is.)

## 12. Streaming & Ring Buffer

### 12.1 Live stream
`capture.stream.start` uses `canvas.captureStream(fps)` → `MediaRecorder` (webm) or per-frame JPEG; frames are pushed to the server as WS binary with `{streamId, frameIndex}` header and relayed to subscribers. Recommended defaults: 10 fps, width 640, JPEG q=0.7.

### 12.2 Ring buffer ("see every action")
- Always-on in-page circular buffer: last N frames (default 300) as low-res JPEG + full event log (default 10,000 entries).
- Per frame record: `{frameIndex, t, jpeg, inputs[], sceneHash}` where `sceneHash` is a cheap transform digest enabling `scene.diff` across time.
- Overhead budget: MUST stay ≤ 5% frame-time impact at defaults; buffer encoding MUST run off the render critical path (async encode, drop-oldest under pressure).
- `replay.last {seconds}` returns frames + events; `replay.export` materializes a trace file (§9.5) on the server.

## 13. Reflex Policy Runtime

Policies are frame-rate code the agent installs in-page so reactions don't pay LLM latency.

```ts
interface Policy {
  name: string;
  trigger: "frame" | { event: string } | { condition: string };
  code: string;       // function body receiving (state, api)
  priority: number;   // execution order
  enabled: boolean;
}
```

- `state` provides read-only queries: `state.object(id|name)`, `state.player` (if registered via `attach` option `playerRef`), `state.raycast(origin, dir, maxDist)`, `state.time`.
- `api` provides: `api.press(code)`, `api.release(code)`, `api.click(x,y)`, `api.log(msg)`, `api.disableSelf()`.
- Frame triggers run inside the bridge tick, after app update, before next render.
- **Fault containment:** a policy throwing MUST be caught, logged as `type:"policy"` event, and the policy auto-disabled after 3 consecutive faults (`POLICY_FAULT` surfaced to agent).
- **Budget guard:** if a policy's average execution exceeds 2 ms/frame it is auto-paused with reason.
- Policy code is subject to the same `allowCode` gate as `eval.js`.

## 14. Optional Adapters

| Adapter | Mechanism | Capability flag |
|---|---|---|
| **Gamepad spoof** | Patch `navigator.getGamepads`, synthesize `gamepadconnected/disconnected`; `input.gamepad` writes into spoofed state objects read each app frame | `gamepad` |
| **Audio tap** | Wrap `AudioContext` constructor; connect master `AnalyserNode` post-destination split; expose level/spectrum; optional raw PCM ring for export | `audio` |
| **Multi-viewport** | Multiple `attach` registrations keyed by `viewportId`; all capture/input commands accept it | `multiview` |

Browser launch MUST set `--autoplay-policy=no-user-gesture-required` when `audio` is requested, and GPU flags appropriate to environment (`--use-angle=swiftshader` / `--enable-unsafe-swiftshader` for software CI; hardware GPU when available).

## 15. Record / Replay of Runs (including human runs)

- `record.start` begins capturing inputs (with `frameIndex` timestamps), periodic keyframes, and events. Works identically for **human input in a headed browser** and agent input — the bridge sees both through the same event hooks.
- `replay.run` requires `time.takeControl` + matching seed; injects recorded inputs at their recorded frames; divergences from the recorded keyframes beyond a threshold produce a `REPLAY_DIVERGED` result with the first divergent frame.
- `replay.branch {atFrame}`: replay to frame, freeze, hand control to the agent — enabling "play like me until the boss, then you take over" and fuzzing from known-good states.
- Traces are the CI artifact: a failing test SHOULD export its trace for offline review.

## 16. MCP Tool Surface

The MCP server maps commands to tools; required set:
`session_new`, `session_attach`, `scene_graph`, `scene_find`, `object_get`, `object_set`, `camera_set`, `capture` (param `view: rgb|id|depth`), `input_click`, `input_keys`, `input_hold`, `time_control`, `wait_for`, `policy_attach`, `policy_remove`, `perf_report`, `js_eval`, `replay_last`, `record_control`.

Rules:
- Image results MUST be returned as MCP image content blocks alongside the `idIndex`/metadata text block when present.
- Every tool result MUST include `frameIndex` so the agent can correlate across calls.
- Tool descriptions MUST state whether the tool is read-only or mutating (agent-side planning depends on this).

## 17. Security & Sandboxing

- **S1.** `eval.js` and policy code are full-privilege in-page. Server config: `allowCode: "local" | "always" | "never"` (default `"local"` = only sessions launched by this server against localhost/allowed origins).
- **S2.** Origin allowlist for `session.new`; attempts to attach to disallowed origins MUST fail with typed error.
- **S3.** Server binds `127.0.0.1` by default; WS/HTTP transports require a bearer token when bound elsewhere.
- **S4.** Command size caps: params ≤ 1 MB, batch ≤ 100 commands, policy code ≤ 100 KB.
- **S5.** Captured frames may contain sensitive content; trace files MUST be written only under the configured artifacts directory.

## 18. Performance Requirements (targets, not estimates)

| ID | Requirement |
|---|---|
| PR-1 | In-page capture ≤ 50 ms at 720p JPEG, ≤ 120 ms PNG |
| PR-2 | Command round-trip (server↔page, excluding model inference) ≤ 100 ms p95 |
| PR-3 | `scene.graph` ≤ 200 ms for 10,000-object scene |
| PR-4 | Ring buffer default config ≤ 5% frame-time overhead |
| PR-5 | 4 concurrent sessions per server worker without cross-session leakage |
| PR-6 | Stream relay ≥ 15 fps at 640px on localhost |

## 19. Error Handling & Recovery

- All failures return typed codes (§7); the bridge MUST never throw uncaught into app code — bridge faults are quarantined and reported via `errors.tail`.
- Stale object ids return `OBJECT_GONE` with a `scene.find` suggestion payload.
- On bridge heartbeat loss (> 3 s), server marks session `detached`, attempts one re-attach, else `SESSION_LOST`.
- Every mutating command returns the resulting state of the affected object so agents never need a follow-up read for confirmation.

## 20. Build Phases & Gate Criteria (scope-gated, not time-gated)

**P0 — Core loop**
Scope: bridge (Mode A), scene graph/find/get/set, capture.rgb, camera.set, server + WS transport + MCP mapping, session lifecycle.
Gate: agent attaches to `examples/cube-scene`, returns the graph, captures a frame, renames/recolors an object, and confirms via `object.get` + second capture.

**P1 — Control & determinism**
Scope: input synthesis (§11), time takeover/pause/step/scale, `wait.for`, Mode B auto-discovery, error taxonomy.
Gate: agent navigates the sample game's menu to gameplay using only captures + inputs; performs a deterministic 600-frame seeded run twice with identical `sceneHash` sequences.

**P2 — Perception at scale**
Scope: capture.id, capture.depth, streaming (§12), ring buffer, `replay.last`, trace export.
Gate: agent resolves "which object is under the crosshair" via ID pass; reviews a 5-second rewind after the fact; overhead within PR-4.

**P3 — Skills & replay**
Scope: policy runtime (§13), record/replay incl. human runs and branching (§15), gamepad spoof, audio tap, `eval.js` gating.
Gate: agent completes the platformer sample's obstacle course using ≥1 policy + time dilation; a human-recorded run replays without divergence and branches cleanly at a chosen frame.

**P4 — Test runner & CI**
Scope: `test-runner` CLI (suite definitions, golden screenshots with pixelmatch/odiff thresholds, seeded runs, parallel shards, trace-on-failure), headless GPU config, docs.
Gate: CI run executes a 10-case suite headless, produces a report with traces, and correctly fails on an intentionally introduced rendering regression.

**P5 (extension)** — Engine adapters (Babylon.js first), Mode C degraded tooling, trace viewer UI.

## 21. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Bundled Three.js copies defeat Mode B | Mode A is the primary path; server capability probe reports mode honestly |
| Apps with custom render loops / Web Workers | Loop takeover hooks cover rAF + setAnimationLoop + Clock; worker-driven sims documented as boundary, `eval.js` escape hatch |
| `preserveDrawingBuffer` blank-frame trap | All capture renders to bridge-owned `WebGLRenderTarget`; never relies on backbuffer |
| Nondeterminism from network/timers | §10.4 boundary + heuristic flagging; suites SHOULD run with network stubbed |
| Frame volume overwhelms agent context | Defaults: low-res JPEG streams, symbolic queries first; agent samples frames at decision points |
| VLMs miss motion/transient effects | Ring buffer rewind + event telemetry as ground truth |
| Security of eval/policy code | §17 gating; default-deny remote |

## 22. Open Questions (resolve during implementation, log decisions in `docs/decisions.md`)

1. Trace file schema versioning strategy for cross-version replay.
2. Whether `scene.diff` should include material/texture changes in v1 or transforms only.
3. Multi-agent contention: lock semantics when two agents attach to one session (proposed: exclusive lease per session).
4. Standardizing a `tj.registerPlayer(object)` convention so `state.player` works across arbitrary apps.

## 23. Glossary

- **Bridge** — the in-page SDK exposing `window.__THREE_AGENT__`.
- **Session** — one browser context + page + bridge binding.
- **Symbolic channel** — scene-graph/JSON access; **visual channel** — frame capture; **control channel** — input/time/policy commands.
- **ID pass** — segmentation render encoding object identity per pixel.
- **Bullet-time** — using `time.scale`/`time.step` so agent cognition outpaces game time.
- **Policy** — frame-rate reflex code installed by the agent (§13).
- **Trace** — portable recording of inputs, keyframes, and events (§9.5).

---
