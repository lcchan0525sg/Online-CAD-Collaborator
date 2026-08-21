// Shared mutable state for the CAD Viewer. Single source of truth for every
// module-scope binding that used to live in main.js. Feature modules import
// { ctx } and read/write ctx.<name>; this module owns the declarations.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const stage = document.getElementById('stage');

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 100000);

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });

const controls = new OrbitControls(camera, renderer.domElement);

const hemi = new THREE.HemisphereLight(0xbcd0ff, 0x20242c, 0.9);

const key = new THREE.DirectionalLight(0xffffff, 2.4);

const fill = new THREE.DirectionalLight(0x8fb2ff, 0.6);

const front = new THREE.DirectionalLight(0xffffff, 0.0);

const LIGHTS = {
  ambient: { label: 'Ambient', obj: hemi,  def: 0.9 },
  key:     { label: 'Key',     obj: key,   def: 2.4 },
  fill:    { label: 'Fill',    obj: fill,  def: 0.6 },
  front:   { label: 'Front',   obj: front, def: 0.0 },
};

let grid = null;

let model = null;      // the loaded (scaled) group

let modelScale = 1;

let modelGen = 0;      // monotonic load token: a stale async load can't clobber a newer one

// The parts tree now renders inside the floating Parts panel (the sidebar no
// longer has its own explorer tree).
const partsEl = document.getElementById('floating-parts-list');

const partRows = new Map();   // pathKey -> { cb, row }

const allPartRows = [];       // every built row: { key, row, toggle, hasKids }

let collapsedPaths = new Set();

const partMenuEl = document.getElementById('part-menu');

const partMenuOnlyEl = document.getElementById('part-menu-only');

const partMenuHideEl = document.getElementById('part-menu-hide');

const partMenuMoveEl = document.getElementById('part-menu-move');

let partMenuKey = null;

let partMenuHideTimer = null;

const partMenuTransEl = document.getElementById('part-menu-trans');

const TRANSPARENT_OPACITY = 0.25;

let transparentParts = new Set();        // pathKey -> currently transparent

const meshBase = new Map();              // mesh -> pristine Material[] at load

const meshPartKey = new Map();           // mesh -> deepest part pathKey it belongs to

const HIGHLIGHT_COLOR = 0x2f7dff;

const HIGHLIGHT_INTENSITY = 0.55;

let applyingRemoteTrans = false;

let pendingRemoteTransKeys = [];

let selectedPartKey = null;

let applyingRemoteParts = false;

let pendingRemoteParts = [];   // ops that arrived before the model was loaded

let applyingRemoteTree = false;

let applyingRemoteSel = false;

let lastGltf = null;

const dracoLoader = new DRACOLoader();

const loader = new GLTFLoader();

let session = null;          // { code, ws, id, isHost, connected }

let roster = [];             // [{id, name, isHost}]

let applyingRemote = false;  // suppress broadcast while applying a remote camera

let lastCamSent = 0;

const CAM_INTERVAL = 40;     // ms between camera broadcasts

let pendingSend = new Set(); // guest ids still to ACK the current shared model (host)

let currentModel = null;     // { buf, filename, kind, note } — host's last shared model

let lastLocalModel = null;   // { buf, filename, kind }

let ackedSend = new Set();   // guest ids that ACKed the current shared model

const sessionStatusEl = document.getElementById('session-status');

const sessionCodeEl = document.getElementById('session-code');

const rosterEl = document.getElementById('roster');

const sessionControlsEl = document.getElementById('session-controls');

const sessionActiveEl = document.getElementById('session-active');

const joinCodeInput = document.getElementById('join-code');

const healthDot = document.getElementById('health-dot');

let healthFailures = 0;

const chatWindowEl = document.getElementById('chat-window');

const chatMessagesEl = document.getElementById('chat-messages');

const chatFormEl = document.getElementById('chat-form');

const chatInputEl = document.getElementById('chat-input');

const btnChatEl = document.getElementById('btn-chat');

const btnChatCloseEl = document.getElementById('btn-chat-close');

const CHAT_HISTORY_MAX = 200;

let chatHistory = [];                 // [{ id, name, text, ts, self }]

let chatSeq = 0;

const btnChatDownloadEl = document.getElementById('btn-chat-download');

const xferOverlayEl = document.getElementById('xfer-overlay');

const xferTitleEl = document.getElementById('xfer-title');

const xferSubEl = document.getElementById('xfer-sub');

const xferBarEl = document.querySelector('#xfer-overlay .xfer-bar');

const xferFillEl = document.getElementById('xfer-fill');

const xferToastEl = document.getElementById('xfer-toast');

let xferToastTimer = null;

let xferBlocking = false;

let xferLog = [];

let xferSeq = 0;             // bumped on begin/done/error so a stale "ready" timeout can't hide a new transfer

let sendGuard = null;        // safety timer so a stalled guest can't block the host

const wire = document.getElementById('chk-wire');

const gridChk = document.getElementById('chk-grid');

const rotateChk = document.getElementById('chk-rotate');

const moveOnChk = document.getElementById('move-on');

const moveAxisEl = document.getElementById('move-axis');

let moveAxis = null;            // 'x' | 'y' | 'z' | null

let moveDragging = false;

let moveStartWorld = new THREE.Vector3();

let moveStartNodePos = new THREE.Vector3();
let moveStartTransform = null;

let movePlane = new THREE.Plane();

let moveRay = new THREE.Raycaster();

const _mv = new THREE.Vector3(), _mv2 = new THREE.Vector3();

let originalPositions = new Map();   // path -> THREE.Vector3 (node.position at load)

let transformHistory = [];            // committed local transforms, newest last
let transformRedo = [];               // undone transforms available for redo

const TRANSFORM_HISTORY_MAX = 200;

const _planePt = new THREE.Vector3();     // current ray/plane intersection

let moveStartPlanePt = new THREE.Vector3(); // plane point captured at drag start

const pickRay = new THREE.Raycaster();

const pickNdc = new THREE.Vector2();

let pickDown = null;   // { x, y } captured on left pointerdown

const AXIS_COLORS = { x: 0xff7b72, y: 0x7ee2a8, z: 0x7cc4ff };

let moveGizmo = new THREE.Group();

let moveGizmoArrows = {};

let moveGizmoActive = null;      // the armed arrow (brighter)

// ---- Rotate (semi-circle arc in the move gizmo) ----
let rotateMode = false;            // R pressed — rotate armed
let rotating = false;              // actively rotating
let rotStartAngle = 0;             // pointer angle around axis at drag start
let rotStartQuat = new THREE.Quaternion();   // node.quaternion at drag start
let rotStartTransform = null;
let rotLocalAxis = new THREE.Vector3();      // rotation axis in node.parent's frame
let rotCenter = new THREE.Vector3();         // world center of rotation (= node world pos)
let rotAxisVec = new THREE.Vector3();        // world rotation axis unit vector
let originalRotations = new Map();           // path -> THREE.Quaternion (node.quaternion at load)
let rotateArc = null;                        // THREE.Line semi-circle
let rotateArcArrow = null;                   // THREE cone at the arc end

let pivotMode = false;                       // centre-handle editing mode
let customPivot = null;                      // world-space pivot, or null = part centre
let pivotDragging = false;
let pivotStartWorld = new THREE.Vector3();
let pivotStartPoint = new THREE.Vector3();
let pivotStartTransform = null;
let pivotHandle = null;
let rotStartWorldMatrix = new THREE.Matrix4();

const measureOnChk = document.getElementById('measure-on');

const measureStatusEl = document.getElementById('measure-status');

const measureClearBtn = document.getElementById('btn-measure-clear');

const measureLabelEl = document.getElementById('measure-label');

const measureListEl = document.getElementById('measure-list');

let measureOn = false;

let measureP1 = null;                 // world Vector3 of the first corner, or null

let measureLayer = new THREE.Group(); // glow + markers + committed dimension lines

let measureGlow = null;               // hover-glow dot

let measureP1Dot = null;              // marker at the first corner

let measureList = [];                 // [{ id, p1, p2, mm }]

let measureSeq = 0;                   // local id generator for new measurements

let applyingRemoteMeasure = false;    // guard: don't re-broadcast applied remote ops

let pendingRemoteMeasures = [];       // measure ops that arrived before a model loaded

const MEASURE_TOL_PX = 12;

const measureCornerCache = new Map();

const measureRay = new THREE.Raycaster();

const partHoverTipEl = document.getElementById('part-hover-tip');

let hoverKey = null;            // the path key currently hovered, or null

let hoverRow = null;            // the tree <label> currently highlighted

let lastHoverPick = 0;          // last pointermove time we raycast

const hoverRay = new THREE.Raycaster();

const HOVER_TICK_MS = 33;

const explodeSliderEl = document.getElementById('explode-slider');

const explodeValEl = document.getElementById('explode-val');

const explodeDirEl = document.getElementById('explode-dir');

const explodeScopeEl = document.getElementById('explode-scope');

let explodeGap = 0;             // mm clear space between boxes

let explodeTargets = [];        // [{ node, parent, resting }] children to spread

let explodeDisplaced = new Map(); // uuid -> { node, resting } every node the explode has ever moved

let explodeDir = 'x';           // 'x' | 'y' | 'z' | 'radial' (radial -> x)

let explodeScopeKey = null;     // selected assembly path key, or null (top level)

let explodeScopeName = '—';     // display name of the scope for the readout

let explodeNothing = false;     // scope has <=1 child (nothing to spread)

let applyingRemoteExplode = false;

const explodeResetEl = document.getElementById('btn-explode-reset');

const animClock = new THREE.Clock();

let mixer = null;          // AnimationMixer for the loaded GLB's clips

let animState = { playing: true, loop: true, speed: 1, clip: -1 };

let pendingRemoteAnim = null;   // anim state received before a model loaded

let userName = '';
export const ctx = {
  stage,
  scene,
  camera,
  renderer,
  controls,
  hemi,
  key,
  fill,
  front,
  LIGHTS,
  grid,
  model,
  modelScale,
  modelGen,
  partsEl,
  partRows,
  allPartRows,
  collapsedPaths,
  partMenuEl,
  partMenuOnlyEl,
  partMenuHideEl,
  partMenuMoveEl,
  partMenuKey,
  partMenuHideTimer,
  partMenuTransEl,
  TRANSPARENT_OPACITY,
  transparentParts,
  meshBase,
  meshPartKey,
  HIGHLIGHT_COLOR,
  HIGHLIGHT_INTENSITY,
  applyingRemoteTrans,
  pendingRemoteTransKeys,
  selectedPartKey,
  applyingRemoteParts,
  pendingRemoteParts,
  applyingRemoteTree,
  applyingRemoteSel,
  lastGltf,
  dracoLoader,
  loader,
  session,
  roster,
  applyingRemote,
  lastCamSent,
  CAM_INTERVAL,
  pendingSend,
  currentModel,
  lastLocalModel,
  ackedSend,
  sessionStatusEl,
  sessionCodeEl,
  rosterEl,
  sessionControlsEl,
  sessionActiveEl,
  joinCodeInput,
  healthDot,
  healthFailures,
  chatWindowEl,
  chatMessagesEl,
  chatFormEl,
  chatInputEl,
  btnChatEl,
  btnChatCloseEl,
  CHAT_HISTORY_MAX,
  chatHistory,
  chatSeq,
  btnChatDownloadEl,
  xferOverlayEl,
  xferTitleEl,
  xferSubEl,
  xferBarEl,
  xferFillEl,
  xferToastEl,
  xferToastTimer,
  xferBlocking,
  xferLog,
  xferSeq,
  sendGuard,
  wire,
  gridChk,
  rotateChk,
  moveOnChk,
  moveAxisEl,
  moveAxis,
  moveDragging,
  moveStartWorld,
  moveStartNodePos,
  moveStartTransform,
  movePlane,
  moveRay,
  _mv,
  _mv2,
  originalPositions,
  transformHistory,
  transformRedo,
  TRANSFORM_HISTORY_MAX,
  _planePt,
  moveStartPlanePt,
  pickRay,
  pickNdc,
  pickDown,
  AXIS_COLORS,
  moveGizmo,
  moveGizmoArrows,
  moveGizmoActive,
  rotateMode,
  rotating,
  rotStartAngle,
  rotStartQuat,
  rotStartTransform,
  rotLocalAxis,
  rotCenter,
  rotAxisVec,
  originalRotations,
  rotateArc,
  rotateArcArrow,
  pivotMode,
  customPivot,
  pivotDragging,
  pivotStartWorld,
  pivotStartPoint,
  pivotStartTransform,
  pivotHandle,
  rotStartWorldMatrix,
  measureOnChk,
  measureStatusEl,
  measureClearBtn,
  measureLabelEl,
  measureListEl,
  measureOn,
  measureP1,
  measureLayer,
  measureGlow,
  measureP1Dot,
  measureList,
  measureSeq,
  applyingRemoteMeasure,
  pendingRemoteMeasures,
  MEASURE_TOL_PX,
  measureCornerCache,
  measureRay,
  partHoverTipEl,
  hoverKey,
  hoverRow,
  lastHoverPick,
  hoverRay,
  HOVER_TICK_MS,
  explodeSliderEl,
  explodeValEl,
  explodeDirEl,
  explodeScopeEl,
  explodeGap,
  explodeTargets,
  explodeDisplaced,
  explodeDir,
  explodeScopeKey,
  explodeScopeName,
  explodeNothing,
  applyingRemoteExplode,
  explodeResetEl,
  animClock,
  mixer,
  animState,
  pendingRemoteAnim,
  userName,
};
