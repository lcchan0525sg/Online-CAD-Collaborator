# CAD Viewer — User Manual

**Version:** v0.2 · **URL:** http://localhost:4322/

CAD Viewer is a real-time collaborative browser app for viewing CAD geometry
(GLBs from SolidEdge, FreeCAD, Fusion 360, OpenCascade…, plus STEP files
converted on the server). Create a session, share a model, and everyone on your
LAN follows your camera and part visibility live — or just use it as a plain
local viewer.

---

## 1. Starting the app

**Portable zip (Windows, no installs):**

1. Unzip `cad-viewer-portable.zip` anywhere.
2. Double-click **`start.bat`**. It launches the server and opens the browser.
3. The app is served at **http://localhost:4322/**

**From source:** `node server.js` in the project folder, then open the same URL.

### Changing the port

The default port is **4322**. Any of these overrides it:

| Method | Example |
|---|---|
| Launcher argument (zip) | `start.bat 5555` |
| `port.txt` file next to `server.js` | create `port.txt` containing `5555` |
| Environment variable | `set PORT=5555` then `node server.js` (Windows) / `PORT=5555 node server.js` (macOS/Linux) |

Precedence: command-line argument → `port.txt` → env `PORT` → default 4322.
The join link and `/ip` address always reflect the actual port, so guests don't
need to know it.

> **STEP files** (.step/.stp) additionally need Docker + the `chair-cq:local`
> OpenCascade image. Run **`install-docker-opencascade.bat`** once to set that
> up. GLB/GLTF files work without any of it.

![Empty start — the viewport is blank until you open a model](manual-shots/01-empty-start.png)

---

## 2. Opening a model

1. Click **Open model…** in the left sidebar.
2. Choose a `.glb`, `.gltf`, `.step` or `.stp` file from your computer.

GLB/GLTF loads instantly. STEP files are converted to GLB by the OpenCascade
kernel on the server (a blocking overlay shows progress — a few seconds).

![A model loaded in the viewport, with Info, Assembly and Materials panels](manual-shots/02-model-loaded.png)

The sidebar shows you:

- **Info** — generator, mesh/triangle counts, dimensions and units
- **Assembly** — the part tree (see §3)
- **Materials** — swatches of every colour in the model

---

## 3. The Assembly panel — parts and visibility

Every part of the model appears in the **Assembly** tree. The tree opens
expanded to **level 2** (the top assembly plus its direct children); deeper
levels are collapsed until you expand them.

![Assembly tree with the part list](manual-shots/03-assembly-panel.png)

### Expand / collapse

- Rows that contain sub-parts show a **+/− toggle** on the left.
- Click **+** to expand (show children), **–** to collapse (hide them).
- Expanding/collapsing is purely visual — it never changes part visibility.

### Show / hide parts

- **Checkbox** per part: uncheck to hide it in the viewport, check to show.
- Toggling a parent cascades to its whole subtree — turning a sub-assembly on
  brings all its children back with it (three.js needs the whole chain visible
  to render anything).
- **Show all / Hide all** buttons apply to the whole model at once.

### Highlight a part (click the name)

Click a part's **name** to highlight it in blue in the viewport. Click another
part to move the highlight; click the same part again to clear it. The highlight
uses per-mesh material copies, so other parts sharing the same source material
are unaffected.

![A part selected in the tree, highlighted blue in the viewport](manual-shots/12-part-selected.png)

### "Show me only" (right-click)

Right-click a part and choose **Show me only** to hide everything except that
part and its children. Ancestors stay visible so the isolated part still renders.

![Right-click context menu with "Show me only"](manual-shots/13-show-me-only-menu.png)

**In a session (see §5), all of this syncs to every member** — show/hide,
expand/collapse, and the selection highlight are mirrored live in both
directions.

---

## 4. Navigating the viewport

| Action | Effect |
|---|---|
| **Drag** (left button) | Orbit the camera |
| **Scroll** | Zoom |
| **Right-drag** | Pan |
| **Frame model** button | Reset the view to fit the model |
| **Wireframe overlay** | Toggle wireframe on all parts |
| **Grid** | Toggle the ground grid |
| **Auto-rotate** | Slow turntable spin (disabled in a session) |

---

## 5. Collaborative sessions (host)

Sessions let other people on your LAN view the same model and follow your
camera and part visibility.

1. Click **Create session** — a 5-character code appears.
2. **Open a model** (or re-share one you've already loaded).
3. Share the **join link** shown under the code, or the code itself, with the
   other users.

![A session created — code and LAN join link shown](manual-shots/04-session-created.png)

While the model is being handed to guests you'll see a blocking
**“Sending model to guest(s)…”** overlay; control is restored automatically once
every connected guest confirms receipt.

![The host's “Sending model to guest(s)” overlay](manual-shots/06-sending-overlay.png)

The roster under the code shows who is connected.

![Host view: guest connected in the roster](manual-shots/05-host-roster.png)

---

## 6. Joining a session (guest)

On another computer (same network):

1. Open the **join link** the host sent you, **or**
2. Open the app, type the code into **session code** and click **Join**.

You'll see a **“Receiving model…”** overlay with byte progress, then the model
appears — same view, same parts, same visibility as the host.

![Guest view after receiving the shared model](manual-shots/07-guest-received.png)

### What stays in sync

- **Camera** — whoever orbits/zooms/pans, everyone follows (both directions)
- **Part visibility** — show/hide any part and it changes for all members
- **The model itself** — late joiners automatically receive the current model
  and visibility state
- **Expand/collapse & selection** — the assembly-tree view and part highlight
  are mirrored live across members

![Part hidden on the host](manual-shots/08-part-toggle.png)
![The same part hidden on the guest — synced](manual-shots/09-guest-part-sync.png)

---

## 7. Leaving a session

Click **Leave session** — you keep your local model and return to solo viewing.
The session itself stays alive on the server for other members.

![After leaving the session](manual-shots/10-after-leave.png)

---

## 8. Opening a STEP file

STEP conversion happens through the OpenCascade kernel (Docker). The first time
you open a STEP file you'll see the conversion overlay; when it finishes the
GLB is loaded — with the original **colours and materials** preserved, and part
names appearing in the Assembly tree.

![STEP file being converted to GLB](manual-shots/11-step-converting.png)

If Docker or the `chair-cq:local` image isn't installed, STEP files show a
conversion error while GLB/GLTF continues to work normally.

---

## 9. Troubleshooting

| Problem | Fix |
|---|---|
| Can't open the app on another PC | Use the **join link** (LAN address), make sure both PCs are on the same network, and that port 4322 isn't blocked by a firewall |
| STEP shows “conversion failed” | Run `install-docker-opencascade.bat`; confirm Docker is running with the `chair-cq:local` image |
| Guest doesn't get the model | The host must be connected with a model loaded — joining an empty session shows nothing until the host shares |
| Port already in use | Change it: `start.bat 4323` (zip), a `port.txt` file, or `set PORT=4323` |
| Join link shows the wrong IP | The link uses the host's LAN address; refresh/re-create the session to re-detect it |

---

*CAD Viewer v0.22 — collaborative CAD viewing for the LAN.*
