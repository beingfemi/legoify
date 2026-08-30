import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";

// ─────────────────────────── LEGO palette ───────────────────────────
const PALETTE = [
  0xf4f4f4, 0xa3a2a4, 0x635f61, 0x2b2b2c, 0x1b1b1b,
  0xc4281c, 0x7c0a02, 0xe3691c, 0xf5c400, 0xfbe6a2,
  0x237841, 0x4b9f4c, 0x789082, 0x0055bf, 0x4c7fd6,
  0x1e2f5c, 0x7a4bab, 0x923978, 0xe4adc8, 0xd0956a,
  0xe4cd9e, 0xaa7f56, 0x5c3c2e, 0x958a73,
];

const toRGB = (h) => ({ r: (h >> 16) & 255, g: (h >> 8) & 255, b: h & 255 });
const PAL_RGB = PALETTE.map((h) => ({ hex: h, ...toRGB(h) }));

function snapToLego(r, g, b) {
  let best = PAL_RGB[0], bd = Infinity;
  for (const c of PAL_RGB) {
    const d = (r - c.r) ** 2 + (g - c.g) ** 2 + (b - c.b) ** 2;
    if (d < bd) { bd = d; best = c; }
  }
  return best.hex;
}

// Character colors, sampled from the photo (and user-editable).
let COLORS = { hair: 0x5c3c2e, skin: 0xd0956a, shirt: 0xc4281c, pants: 0x1e2f5c, shoe: 0x1b1b1b };
const SWATCH_KEYS = ["hair", "skin", "shirt", "pants", "shoe"];
const SWATCH_LABELS = { hair: "Hair", skin: "Skin", shirt: "Shirt", pants: "Legs", shoe: "Shoes" };
const EYE = 0x1b1b1b;

// ─────────────────────── Photo → character colors ───────────────────────
const srcCanvas = document.getElementById("sourceCanvas");

// Most-common LEGO color inside a normalized region of the image.
function dominantIn(data, W, H, x0, y0, x1, y1) {
  const counts = new Map();
  const ax = Math.floor(x0 * W), bx = Math.ceil(x1 * W);
  const ay = Math.floor(y0 * H), by = Math.ceil(y1 * H);
  for (let y = ay; y < by; y++) {
    for (let x = ax; x < bx; x++) {
      const i = (y * W + x) * 4;
      if (data[i + 3] < 40) continue;
      const hex = snapToLego(data[i], data[i + 1], data[i + 2]);
      counts.set(hex, (counts.get(hex) || 0) + 1);
    }
  }
  let best = null, bc = -1;
  for (const [hex, n] of counts) if (n > bc) { bc = n; best = hex; }
  return best;
}

function readColorsFromImage(img) {
  const S = 128;
  const ctx = srcCanvas.getContext("2d", { willReadFrequently: true });
  const side = Math.min(img.width, img.height);
  srcCanvas.width = S; srcCanvas.height = S;
  ctx.clearRect(0, 0, S, S);
  ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S, S);
  const { data } = ctx.getImageData(0, 0, S, S);

  const hair  = dominantIn(data, S, S, 0.30, 0.06, 0.70, 0.20);
  const skin  = dominantIn(data, S, S, 0.36, 0.32, 0.64, 0.50);
  const shirt = dominantIn(data, S, S, 0.22, 0.72, 0.78, 0.94);
  let pants   = dominantIn(data, S, S, 0.30, 0.94, 0.70, 1.00);
  if (pants === shirt) pants = 0x1e2f5c;

  COLORS = { hair, skin, shirt, pants, shoe: 0x1b1b1b };
  renderSwatches();
}

// ─────────────────────────── Geometry helpers ───────────────────────────
const BW = 1.0;   // brick width / depth (world units)
const BH = 1.2;   // brick height

const v3 = new THREE.Vector3();
const pa = new THREE.Vector3(), pb = new THREE.Vector3(), pab = new THREE.Vector3();

function distToSegment(px, py, pz, ax, ay, az, bx, by, bz) {
  pa.set(px - ax, py - ay, pz - az);
  pab.set(bx - ax, by - ay, bz - az);
  const len2 = pab.lengthSq();
  const t = len2 === 0 ? 0 : THREE.MathUtils.clamp(pa.dot(pab) / len2, 0, 1);
  pb.copy(pab).multiplyScalar(t);
  return pa.sub(pb).length();
}

const inEllipsoid = (px, py, pz, cx, cy, cz, rx, ry, rz) =>
  ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 + ((pz - cz) / rz) ** 2 <= 1;

// ─────────────────────────── Character model ───────────────────────────
// Grid indices; world = (ix*BW, iy*BH, iz*BW). Figure stands on y = 0.
const GX = 12, GY = 36, GZ = 8;

const SHOULDER_Y = 28.0;
const SHOULDER_X = 5.9;

const POSES = {
  stand: { L: [-8.0, 17.5, 0.8], R: [8.0, 17.5, 0.8] },
  point: { L: [-8.0, 17.5, 0.8], R: [7.4, 40.0, 1.4] },
  cheer: { L: [-7.4, 40.0, 1.4], R: [7.4, 40.0, 1.4] },
};
let currentPose = "stand";

function buildVoxels() {
  const vox = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  const hands = POSES[currentPose];

  const arms = [
    { sx: -SHOULDER_X, hand: hands.L },
    { sx: SHOULDER_X, hand: hands.R },
  ];

  for (let ix = -GX; ix <= GX; ix++) {
    for (let iy = 0; iy <= GY; iy++) {
      for (let iz = -GZ; iz <= GZ; iz++) {
        const x = ix * BW, y = iy * BH, z = iz * BW;
        let c = null;

        // legs — kept far enough apart to leave a real gap
        for (const sx of [-3.1, 3.1]) {
          if (distToSegment(x, y, z, sx, 16.5, 0, sx, 3.0, 0) <= 2.2) c = COLORS.pants;
        }
        // feet
        for (const sx of [-3.1, 3.1]) {
          if (inEllipsoid(x, y, z, sx, 1.3, 1.4, 2.3, 1.4, 3.6)) c = COLORS.shoe;
        }
        // hips
        if (inEllipsoid(x, y, z, 0, 16.8, 0, 4.6, 3.1, 3.3)) c = COLORS.pants;

        // torso — tapered ellipse per height
        if (y >= 17.0 && y <= 29.2) {
          const t = (y - 17.0) / 12.2;
          const rx = THREE.MathUtils.lerp(4.2, 6.2, t);
          const rz = THREE.MathUtils.lerp(3.0, 4.0, t);
          if ((x / rx) ** 2 + (z / rz) ** 2 <= 1) c = COLORS.shirt;
        }

        // arms — shoulder → elbow → hand, sleeve on the upper half
        for (const { sx, hand } of arms) {
          const ex = (sx + hand[0]) / 2 + Math.sign(sx) * 0.35;
          const ey = (SHOULDER_Y + hand[1]) / 2;
          const ez = hand[2] / 2;
          const dUp = distToSegment(x, y, z, sx, SHOULDER_Y, 0, ex, ey, ez);
          const dLo = distToSegment(x, y, z, ex, ey, ez, hand[0], hand[1], hand[2]);
          if (dUp <= 2.15) c = COLORS.shirt;
          if (dLo <= 1.95) c = COLORS.skin;
          if (inEllipsoid(x, y, z, hand[0], hand[1], hand[2], 2.3, 2.3, 2.3)) c = COLORS.skin;
        }

        // neck + head
        if (distToSegment(x, y, z, 0, 29.0, 0, 0, 31.5, 0) <= 2.2) c = COLORS.skin;
        if (inEllipsoid(x, y, z, 0, 35.6, 0, 5.7, 5.9, 5.3)) {
          c = COLORS.skin;
          // hair: crown, back of head, and short sides
          const crown = y >= 37.8;
          const back = z <= -2.2 && y >= 33.0;
          const sides = Math.abs(x) >= 4.0 && y >= 35.0;
          if (crown || back || sides) c = COLORS.hair;
        }

        if (c !== null) vox.set(key(ix, iy, iz), c);
      }
    }
  }

  addFace(vox, key);
  return vox;
}

// Eyes + mouth: recolor the frontmost voxel of the head at given heights.
function addFace(vox, key) {
  const frontmost = (ix, iy) => {
    for (let iz = GZ; iz >= -GZ; iz--) if (vox.has(key(ix, iy, iz))) return iz;
    return null;
  };
  const row = (worldY) => Math.round(worldY / BH);

  const eyeRow = row(36.4);
  for (const ix of [-3, -2, 2, 3]) {
    const iz = frontmost(ix, eyeRow);
    if (iz !== null) vox.set(key(ix, eyeRow, iz), EYE);
  }
  // brow line just above the eyes
  const browRow = eyeRow + 1;
  for (const ix of [-3, -2, 2, 3]) {
    const iz = frontmost(ix, browRow);
    if (iz !== null) vox.set(key(ix, browRow, iz), COLORS.hair);
  }
  const mouthRow = row(32.6);
  for (const ix of [-1, 0, 1]) {
    const iz = frontmost(ix, mouthRow);
    if (iz !== null) vox.set(key(ix, mouthRow, iz), 0x7c0a02);
  }
}

// ─────────────────────────── Brick geometry ───────────────────────────
const brickPlain = new RoundedBoxGeometry(BW * 0.98, BH * 0.98, BW * 0.98, 2, 0.055).toNonIndexed();
const studGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.24, 18).toNonIndexed();
studGeo.translate(0, BH * 0.49 + 0.11, 0);
const brickStudded = BufferGeometryUtils.mergeGeometries([brickPlain, studGeo], false);

// ─────────────────────────── Scene ───────────────────────────
let renderer, scene, camera, controls, figure;
let anims = [], animating = false, animStart = 0;
let userTouched = false;

const canvas = document.getElementById("scene");
const loadingEl = document.getElementById("loading");
const tallyEl = document.getElementById("brickTally");

function initScene() {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0xffffff, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();

  // Studio reflections (no external assets).
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  camera = new THREE.PerspectiveCamera(34, 1, 0.5, 400);
  camera.position.set(26, 26, 52);

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.minDistance = 22;
  controls.maxDistance = 120;
  controls.target.set(0, 17, 0);
  controls.addEventListener("start", () => { userTouched = true; });

  const key = new THREE.DirectionalLight(0xffffff, 2.6);
  key.position.set(20, 34, 24);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.radius = 4;
  key.shadow.bias = -0.0009;
  const d = 26;
  Object.assign(key.shadow.camera, { left: -d, right: d, top: d + 12, bottom: -d, near: 1, far: 110 });
  key.shadow.camera.updateProjectionMatrix();
  scene.add(key);

  const rim = new THREE.DirectionalLight(0xffffff, 0.7);
  rim.position.set(-22, 16, -20);
  scene.add(rim);
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));

  // Shadow-only ground keeps the page pure white.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(300, 300),
    new THREE.ShadowMaterial({ opacity: 0.17 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  addEventListener("resize", onResize);
  onResize();
  renderer.setAnimationLoop(tick);
}

function onResize() {
  if (!renderer) return;
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// ─────────────────────────── Assembly ───────────────────────────
const dummy = new THREE.Object3D();

function buildFigure() {
  if (figure) {
    scene.remove(figure);
    figure.traverse((o) => { if (o.isInstancedMesh) { o.geometry.dispose?.(); o.material.dispose?.(); } });
  }
  figure = new THREE.Group();
  anims = [];

  const vox = buildVoxels();
  const has = (x, y, z) => vox.has(`${x},${y},${z}`);

  // Only keep bricks on the surface; group them by colour and stud/no-stud.
  const buckets = new Map();
  for (const [k, color] of vox) {
    const [x, y, z] = k.split(",").map(Number);
    const enclosed =
      has(x + 1, y, z) && has(x - 1, y, z) &&
      has(x, y + 1, z) && has(x, y - 1, z) &&
      has(x, y, z + 1) && has(x, y, z - 1);
    if (enclosed) continue;

    const studded = !has(x, y + 1, z);
    const bk = `${color}|${studded}`;
    if (!buckets.has(bk)) buckets.set(bk, { color, studded, cells: [] });
    buckets.get(bk).cells.push([x, y, z]);
  }

  let total = 0;
  for (const { color, studded, cells } of buckets.values()) {
    const mat = new THREE.MeshPhysicalMaterial({
      color,
      roughness: 0.38,
      metalness: 0.0,
      clearcoat: 0.55,
      clearcoatRoughness: 0.28,
    });
    const mesh = new THREE.InstancedMesh(studded ? brickStudded : brickPlain, mat, cells.length);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    cells.forEach(([x, y, z], i) => {
      const target = new THREE.Vector3(x * BW, y * BH + BH / 2, z * BW);
      dummy.position.copy(target);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      anims.push({
        mesh, i, target,
        from: target.y + 16 + Math.random() * 22,
        delay: 0.16 + (y / GY) * 0.75 + Math.random() * 0.28,
      });
      total++;
    });
    mesh.instanceMatrix.needsUpdate = true;
    figure.add(mesh);
  }

  scene.add(figure);
  tallyEl.textContent = `${total.toLocaleString()} bricks`;
  startAssembly();
}

function startAssembly() {
  animStart = performance.now() / 1000;
  animating = true;
}

function tick() {
  if (animating) {
    const t = performance.now() / 1000 - animStart;
    let busy = false;
    const touched = new Set();
    for (const a of anims) {
      let p;
      if (t < a.delay) { p = 0; busy = true; }
      else {
        p = Math.min(1, (t - a.delay) / 0.42);
        if (p < 1) busy = true;
      }
      const e = 1 - Math.pow(1 - p, 3);
      dummy.position.set(a.target.x, THREE.MathUtils.lerp(a.from, a.target.y, e), a.target.z);
      dummy.scale.setScalar(THREE.MathUtils.lerp(0.35, 1, e));
      dummy.updateMatrix();
      a.mesh.setMatrixAt(a.i, dummy.matrix);
      touched.add(a.mesh);
    }
    for (const m of touched) m.instanceMatrix.needsUpdate = true;
    animating = busy;
  }

  if (figure && !userTouched) figure.rotation.y += 0.0035;
  controls.update();
  renderer.render(scene, camera);
}

// ─────────────────────────── UI ───────────────────────────
const uploadStage = document.getElementById("uploadStage");
const buildStage = document.getElementById("buildStage");
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const swatchesEl = document.getElementById("swatches");
const popEl = document.getElementById("palettePop");

function renderSwatches() {
  swatchesEl.innerHTML = "";
  for (const k of SWATCH_KEYS) {
    const b = document.createElement("button");
    b.className = "swatch";
    b.style.background = "#" + COLORS[k].toString(16).padStart(6, "0");
    b.title = SWATCH_LABELS[k];
    b.addEventListener("click", (e) => { e.stopPropagation(); openPalette(b, k); });
    swatchesEl.appendChild(b);
  }
}

function openPalette(anchor, slot) {
  popEl.innerHTML = "";
  for (const hex of PALETTE) {
    const b = document.createElement("button");
    b.style.background = "#" + hex.toString(16).padStart(6, "0");
    b.addEventListener("click", () => {
      COLORS[slot] = hex;
      renderSwatches();
      popEl.classList.add("hidden");
      buildFigure();
    });
    popEl.appendChild(b);
  }
  popEl.classList.remove("hidden");
  const r = anchor.getBoundingClientRect();
  popEl.style.left = Math.max(8, Math.min(r.left - 60, innerWidth - 200)) + "px";
  popEl.style.top = r.top - popEl.offsetHeight - 10 + "px";
}
addEventListener("click", () => popEl.classList.add("hidden"));

function enterBuild() {
  uploadStage.classList.add("hidden");
  buildStage.classList.remove("hidden");
  if (!renderer) initScene(); else onResize();
  loadingEl.classList.remove("hidden");
  requestAnimationFrame(() => requestAnimationFrame(() => {
    buildFigure();
    loadingEl.classList.add("hidden");
  }));
}

function handleFile(file) {
  const fr = new FileReader();
  fr.onload = (e) => {
    const img = new Image();
    img.onload = () => { readColorsFromImage(img); enterBuild(); };
    img.src = e.target.result;
  };
  fr.readAsDataURL(file);
}

fileInput.addEventListener("change", (e) => e.target.files[0] && handleFile(e.target.files[0]));
["dragenter", "dragover"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("dragover"); }));
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("dragover"); }));
dropzone.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files[0];
  if (f?.type.startsWith("image/")) handleFile(f);
});

document.getElementById("sampleBtn").addEventListener("click", () => {
  COLORS = { hair: 0x5c3c2e, skin: 0xd0956a, shirt: 0xc4281c, pants: 0x1e2f5c, shoe: 0x1b1b1b };
  renderSwatches();
  enterBuild();
});

document.getElementById("poses").addEventListener("click", (e) => {
  const btn = e.target.closest(".pose-btn");
  if (!btn) return;
  document.querySelectorAll(".pose-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
  currentPose = btn.dataset.pose;
  buildFigure();
});

document.getElementById("replayBtn").addEventListener("click", startAssembly);

document.getElementById("shotBtn").addEventListener("click", () => {
  renderer.render(scene, camera);
  const a = document.createElement("a");
  a.download = "legoify.png";
  a.href = renderer.domElement.toDataURL("image/png");
  a.click();
});

document.getElementById("newBtn").addEventListener("click", () => {
  buildStage.classList.add("hidden");
  uploadStage.classList.remove("hidden");
  fileInput.value = "";
});

renderSwatches();
