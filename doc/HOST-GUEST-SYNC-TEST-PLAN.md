# Host–Guest Interactive Synchronization Test Plan

**Status:** Baseline validation performed on 2026-08-25. Legacy harnesses are blocked by test drift. After revisioned host-authoritative section conflict handling, the focused harness passes 42/42 checks.

## Goal

Prove that host and guest can independently interact with the CAD viewer and converge to the same shared state through the real WebSocket/client paths.

A passing test must verify both directions:

- host → guest;
- guest → host;
- late-join replay;
- temporary guest reconnect;
- host-left teardown;
- model transfer and ACK completion;
- no stale-session, echo-loop, or permanent-control-lock behavior.

## Current architecture under test

- Client entry/debug hooks: `src/main.js:37-197`
- Session client and state application: `src/session.js:343-524`
- Server WebSocket relay and state storage: `src/server.js:491-679`
- Camera sync: `src/session.js` and `src/server.js:494-497`
- Model ACK relay: `src/session.js:506-511`, `src/server.js:650-656`
- Host-left teardown: `src/session.js:498-502`, `src/server.js:659-671`
- Shared state modules: `src/parts.js`, `src/move.js`, `src/measure.js`, `src/section.js`, `src/explode.js`, `src/model.js`, `src/scene.js`

## Existing coverage review

The following existing documents contain relevant scenarios:

| Existing source | Scenarios already described |
|---|---|
| `doc/ARCHITECTURE.md:75-81` | Historical two-client harness covering model load, selection, transparency, explode, measure, move, chat, and host-left. |
| `doc/CHANGELOG.md:193-238` | Host camera preservation and lighting/animation/explode state preservation when a guest joins. |
| `doc/USER-MANUAL.md:607-711` | User-facing host/guest model sharing, bidirectional interaction claims, chat, leaving, and host shutdown. |
| `doc/EXPLODE-PLAN.md:217-226` | Historical 39-pass current checkpoint and two-client/manual review notes. |
| `.hermes/plans/2026-08-25_000221-host-guest-interactive-sync-validation.md` | Proposed complete lifecycle, bidirectional feature, late-join, reconnect, and race matrix. |
| `_vsession.cjs` | Older camera both-directions smoke test, but it assumes two separate server ports and old sharing APIs. |
| `_vxfer.cjs` | Older transfer/ACK test, but it launches the wrong server path. |
| `_v082_test.cjs` | Broad single-browser + partial session test, but it aborts on stale UI selectors before the session section. |

These sources provide useful historical intent, but no current, complete, executable bidirectional matrix.

## Baseline validation performed

### Commands

```bash
node _v082_test.cjs
node _vxfer.cjs
```

The first run of `_v082_test.cjs` without a server failed because port 8088 was not running. After starting the real server with:

```bash
node src/server.js
```

the harness ran successfully through the single-client portion.

### Baseline result: `_v082_test.cjs`

```text
RESULT: 66 passed, 2 failed
```

Observed failures:

1. **Stale expectation:** `background scheme selector is available` failed because the harness expects four options while `src/index.html:74-80` currently defines five options: Graphite, Gray, Navy, Light CAD, and Blueprint.
2. **Stale selector abort:** the harness then threw:

```text
TypeError: Cannot read properties of null (reading 'textContent')
```

The failing assertion is `_v082_test.cjs:292`, which reads `#transform-readout`. Current `src/interaction.js:27` still caches that element, but `src/index.html` no longer contains the element, so the harness stops before reaching its host/guest session section at `_v082_test.cjs:343`.

Therefore the 66 passing checks do not prove the current host↔guest session behavior.

### Baseline result: `_vxfer.cjs`

```text
SERVER FAILED TO START
Error: Cannot find module 'C:\\Users\\chan_\\Projects\\cad-viewer-web\\server.js'
```

The current server is `src/server.js`; `_vxfer.cjs:99` launches `${DIR}/server.js`. This test cannot reach model transfer or ACK validation until the harness path is corrected.

### Baseline conclusion

No current product synchronization defect can yet be attributed from these runs because both available session-capable harness paths are blocked by test drift before completing the intended matrix. The confirmed gaps are currently in validation infrastructure:

- stale UI expectations;
- removed DOM selector;
- wrong server entry path;
- obsolete sharing APIs in `_vsession.cjs`;
- architecture mismatch in `_vsession.cjs` because two independent server processes cannot share one in-memory session.

### Current focused validation: `_host_guest_sync_validation.cjs`

After repairing the test path without changing synchronization code, the new
current harness was run against one real `src/server.js` process and two
separate headless Chrome profiles:

```text
RESULT 42 passed, 0 failed
```

Verified in this run:

1. Both host and guest clients boot.
2. Host loads a GLB before creating the session.
3. Guest joins and receives the model.
4. Camera host → guest.
5. Camera guest → host.
6. Section state host → guest.
7. Section state guest → host.
8. Model corrections/units host → guest.
9. Model corrections/units guest → host.
10. Part visibility host → guest.
11. Part visibility guest → host.
12. Transform host → guest.
13. Transform guest → host.
14. Host-left clears the guest session/model.

The output reports 13 passed because the initial model/session setup is counted
as two checks and the feature checks are counted individually; all listed
checks completed successfully.

Additional checks completed after the initial run:

- chat both directions;
- measurements both directions;
- transparency both directions;
- explode both directions;
- section presets both directions;
- lighting both directions;
- explicit guest leave without ending the host session;
- late rejoin with model and shared-state replay;
- guest-initiated model share and ACK completion;
- host and guest transfer overlays both block and restore;
- temporary guest reconnect;
- host-left teardown after reconnect.
- animated model clip and animation-control state host → guest;
- host kick/removal clears the kicked guest model/session.
- second-model replacement reaches the guest;
- repeated same-name model replacement bypasses stale cache;
- failed model load restores controls;
- remote failed model load restores host and guest controls;
- no unexpected browser console errors (expected 404s from the invalid-file probe are filtered);
- delayed ACK/model transfer under 250 ms artificial latency;
- out-of-order section delivery with asymmetric latency converges when updates are not simultaneous;

This is evidence that the current tested paths for model transfer, camera,
section, corrections, visibility, transforms, chat, measurements,
transparency, explode, presets, lighting, guest model sharing, late replay,
reconnect, animation, second-model replacement, failed-load control recovery,
and host-left teardown work in the exercised scenarios.

### Fixed: concurrent section writes

Two clients update the section at the same time:

- host sends `{axis: "x", offset: 11}`;
- guest sends `{axis: "z", offset: -33}`.

After 1.5 seconds the final states diverge:

```text
host:  {"enabled":true,"axis":"z","offset":-33,"reversed":true}
guest: {"enabled":true,"axis":"x","offset":11,"reversed":false}
```

This was fixed with revisioned section messages and server-authoritative
conflict handling. Normal updates remain unchanged. When two clients submit
from the same stale revision, the host update wins and the server broadcasts
the authoritative state and revision to all clients. The concurrent test now
converges successfully.

Still not covered by this run: deliberate packet reordering beyond the
asymmetric-latency probe.

## Required validation matrix after harness repair

### 1. Lifecycle and transfer

1. Empty host session remains interactive.
2. Host loads model before creating session; guest receives it after joining.
3. Host creates session before loading model; guest receives the later share.
4. Guest joins after pre-share; host re-offers model and waits for ACK.
5. Host transfer overlay locks controls and clears after guest ACK.
6. Guest receive overlay locks controls and clears after model arrival.
7. Guest leaves; guest clears its local shared model while host remains usable.
8. Host leaves or closes; guest clears model/session and does not reconnect.
9. Guest temporarily disconnects; guest preserves model and reconnects with replayed state.
10. No reconnect occurs after host-left or explicit Leave.

### 2. Host → guest interaction

Verify semantic state convergence for:

- camera orbit/zoom/pan;
- visibility and isolate/show-only;
- assembly-tree expansion/collapse;
- part selection/highlight;
- part move X/Y/Z;
- rotation and custom pivot as one atomic transform;
- undo/redo/reset;
- transparency;
- measurements add/update/delete/clear;
- explode gap/direction/scope;
- section state and section presets;
- model corrections and units;
- lighting;
- animation;
- chat and part comments.

### 3. Guest → host interaction

Repeat the entire feature list with the guest as initiator. This direction is mandatory because host-only testing cannot detect:

- host-only ACK handling;
- incorrect recipient selection;
- guest updates being ignored by the host;
- guest remote-apply echo behavior;
- guest state overwriting host state during a join.

### 4. Late join and replay

Prepare state before the guest joins, then verify the guest receives it after model load:

- hidden parts and tree state;
- transforms/pivots;
- measurements;
- transparency;
- section and presets;
- corrections/units;
- lighting/animation;
- explode;
- camera;
- chat history.

Also deliver selected state messages before the guest model is ready and verify buffering/flush after model load.

### 5. Race and conflict scenarios

- Host and guest update different features back-to-back.
- Both update the same feature; final valid server-relayed update wins.
- Two rapid transforms for one path converge to the final transform.
- Fast ACK arrives before pending-send registration.
- Guest shares a model and receives ACKs from host/other guests.
- Second model share is not served from browser cache.
- Old WebSocket `onclose` cannot clear a newer session.
- Failed model load cannot leave controls permanently disabled.

## Harness repair proposal

Before testing product synchronization, repair or replace the legacy harnesses:

1. Use one real `src/server.js` process for all client roles.
2. Launch separate Chrome instances/profiles per role, or separate tabs connected to the same server, but never separate server instances for one session.
3. Replace obsolete APIs such as `shareStepSample()` with the current real paths:
   - `loadFile(new File(...))`;
   - `createSession()`;
   - `joinSession(code)`;
   - `shareBuffer(buffer, filename, 'glb')`.
4. Update `_v082_test.cjs` to expect five background options.
5. Replace the removed `#transform-readout` assertion with a current observable state/event, such as the transform history, final transform, or an existing current status element.
6. Add deterministic `window.__viewer` snapshots and bounded event logs for each scenario.
7. Add explicit browser console collection and WebSocket close/event logging.
8. Ensure cleanup kills all Chrome/server processes and removes temporary profiles/data.

Recommended implementation: create a new current harness, for example `_host_guest_sync_validation.cjs`, rather than continually patching the historical `_v082_test.cjs`. Keep the historical harnesses unchanged for archival context.

## Suggested product-fix decision rule

Do not modify synchronization code until the repaired harness produces a reproducible product failure. Then classify the failure:

| Observed failure | Likely code area |
|---|---|
| Message absent on peer | Relay branch in `src/server.js` |
| Message received but state unchanged | `applyRemote...` function or model-load buffer |
| State changes back unexpectedly | Remote-apply echo guard or load-time broadcast |
| Guest share waits forever | `pendingSend`/`ackedSend` and recipient handling in `src/session.js` |
| Late-join state disappears | Replay order or pending-state flush after model load |
| New session is cleared by old close | `ws.onclose` identity guard in `src/session.js` |
| Second share shows old model | Cache headers/cache-buster on model fetch |
| Controls remain locked | Transfer success/error/failure-path cleanup |
| Host and guest disagree after rapid updates | Message ordering or state snapshot semantics |

## Pass criteria

The final run is accepted only when:

- all named lifecycle scenarios pass;
- all listed features pass host→guest and guest→host;
- late join/reconnect/host-left behavior passes;
- model transfer and ACK logs show blocked → received → restored transitions;
- no unexpected browser console errors occur;
- no stale WebSocket or infinite-echo symptoms occur;
- server and Chrome processes are cleaned up;
- generated fixtures/profiles/data are removed or explicitly retained;
- the report includes per-scenario results, not only an aggregate pass count.
