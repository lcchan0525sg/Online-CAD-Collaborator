# CAD Viewer — Module Architecture

This document records how the viewer's client code is organised after the v0.81
modularization. Previously all of it lived in a single `src/main.js`
(~3,169 lines). It was split into concern-based ES modules, with **behaviour
preserved exactly** — this is a structural refactor, not a feature change.

## File layout (`src/`)

| File | Lines | Responsibility |
|---|---|---|
| `context.js` | ~450 | The single shared-mutable-state object `ctx` plus every initializer (DOM lookups + THREE creation run at module-eval). Every other module imports it. |
| `scene.js` | ~580 | Renderer / camera / lights / grid, model loading (`loadUrl`/`loadFile`/`importStep`/`loadFromGltf`/`orientModel`/`frameModel`/`showInfo`), animation mixer + anim UI, lighting controls, `resize`. |
| `parts.js` | ~490 | Assembly tree build, visibility, selection, transparency, hover tooltip, part context menu — plus their WebSocket sync functions. |
| `session.js` | ~720 | WebSocket client (`connectTo`/`onSessionMsg`/`onclose`), roster, chat, health, model transfer (`shareBuffer`/`loadSharedModel`/`sendModelToPeers` + the `xfer*` overlay), session buttons, `endSessionForGuest`, name prompt (`askName`/`ensureName`/`storedName`), camera/light/animation sync. |
| `measure.js` | ~400 | Measure tool + its sync functions. |
| `move.js` | ~650 | Part move, rotate, custom-pivot editing, unified transform history, Undo/Redo, X/Y/Z gizmo, and transform sync functions. |
| `explode.js` | ~275 | Explode tool + its sync functions. |
| `main.js` | ~210 | Imports every module for its side effects, then only: the render loop, the boot sequence (`?s=` deep-link join), and the `window.__viewer` debug-hook object. |

## Dependency graph

```
                     ┌──────────────┐
                     │  context.js  │   everything imports { ctx }
                     └──────┬───────┘
   ┌──────┬──────┬──────────┼─────────┬──────┬──────┐
   ▼      ▼      ▼          ▼         ▼      ▼      ▼
 scene  parts  measure   explode     move  session
   │      │      │        │   │       │  │    │  │
   └──────┴──┬───┴───┬────┘   └──┬────┘  └────┘  │
             └───────┴──────────┴────────────────┘    cross-module calls via explicit imports
   └────────────── all six imported by ──► main.js   (side effects + boot + render loop + __viewer)
```

ESM import cycles are safe here because **every cross-module call happens at
call-time inside a function body, never at module-eval time**. Function
declarations stay hoisted within each module.

## The `ctx` pattern (shared state)

All shared mutable state lives on **one** object:

```js
// context.js (abridged)
export const ctx = {
  scene, camera, renderer, controls, hemi, key, fill, front, LIGHTS, grid,
  model, modelScale, modelGen,
  session, roster, selectedPartKey, partRows, ...,
  // DOM element refs, THREE objects, mutable state and constants — all on ctx
};
```

- Every feature module does `import { ctx } from './context.js'` and reads/writes
  `ctx.<name>`.
- Put **all** shared module-scope bindings on `ctx` (state, DOM refs, THREE
  objects and constants alike). Don't reintroduce bare module-scope `let/const`
  for shared state — it causes live-binding/reassignment confusion.
- `context.js` imports `three` (and addons) and performs DOM lookups at
  module-eval time, so the `ctx` objects are built once, before any feature runs.

## Conventions

- **Cross-module calls** — `import { fnName } from './parts.js'` etc. Export every
  function another module calls; same-module-only functions may stay unexported.
- **Side effects** — DOM `addEventListener` registrations and top-level setup move
  into the module that owns the feature, so they still run exactly once when that
  module is imported. `main.js` imports all six modules, so all wiring runs.
- **Preserved as-is** — the `window.__viewer` debug hooks (used by the headless
  test harness), the `window.__selKey` debug assignment, and the render loop stay
  in `main.js`.
- **Untouched** — `server.js` and the WebSocket wire protocol were not changed;
  the modularization is purely client-side.

## Verification

- `node --check` passes on all 8 files.
- A headless two-tab harness (Chrome CDP) exercises the full feature set:
  load GLB, parts tree, selection + highlight, transparency, explode, measure,
  move (real pointer drag), and a live session (create, guest model share, chat,
  host-left clears the guest and ends the session). All pass.
