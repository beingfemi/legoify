import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// ---------- LEGO color palette (approximate official brick colors) ----------
const LEGO_PALETTE = [
  { name: "White", hex: 0xf4f4f4 },
  { name: "Black", hex: 0x1b1b1b },
  { name: "Bright Red", hex: 0xc4281c },
  { name: "Dark Red", hex: 0x7c0a02 },
  { name: "Bright Yellow", hex: 0xf5c400 },
  { name: "Bright Orange", hex: 0xe3691c },
  { name: "Medium Blue", hex: 0x4c7fd6 },
  { name: "Bright Blue", hex: 0x0055bf },
  { name: "Dark Blue", hex: 0x1e2f5c },
  { name: "Bright Green", hex: 0x237841 },
  { name: "Medium Green", hex: 0x4b9f4c },
  { name: "Sand Green", hex: 0x789082 },
  { name: "Tan", hex: 0xe4cd9e },
  { name: "Dark Tan", hex: 0x958a73 },
  { name: "Nougat", hex: 0xd0956a },
  { name: "Reddish Brown", hex: 0x5c3c2e },
  { name: "Medium Nougat", hex: 0xaa7f56 },
  { name: "Light Grey", hex: 0xa3a2a4 },
  { name: "Dark Grey", hex: 0x635f61 },
  { name: "Dark Bluish Grey", hex: 0x595d60 },
  { name: "Magenta", hex: 0x923978 },
  { name: "Bright Purple", hex: 0x7a4bab },
  { name: "Medium Lavender", hex: 0x9391e4 },
  { name: "Bright Pink", hex: 0xe4adc8 },
];

const paletteRGB = LEGO_PALETTE.map((c) => {
  const r = (c.hex >> 16) & 255;
  const g = (c.hex >> 8) & 255;
  const b = c.hex & 255;
  return { ...c, r, g, b };
});

function nearestLegoColor(r, g, b) {
  let best = paletteRGB[0];
  let bestDist = Infinity;
  for (const c of paletteRGB) {
    const dr = r - c.r, dg = g - c.g, db = b - c.b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestDist) { bestDist = d; best = c; }
  }
  return best;
}

// ---------- DOM ----------
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const uploadStage = document.getElementById("uploadStage");
const buildStage = document.getElementById("buildStage");
const resolutionInput = document.getElementById("resolution");
const resVal = document.getElementById("resVal");
const brickHeightInput = document.getElementById("brickHeight");
const rebuildBtn = document.getElementById("rebuildBtn");
const newPhotoBtn = document.getElementById("newPhotoBtn");
const screenshotBtn = document.getElementById("screenshotBtn");
const loadingOverlay = document.getElementById("loadingOverlay");
const loadingText = document.getElementById("loadingText");
const brickCountEl = document.getElementById("brickCount");
const colorCountEl = document.getElementById("colorCount");
const sourceCanvas = document.getElementById("sourceCanvas");
const exampleBtn = document.querySelector(".example-btn");

let currentImage = null; // HTMLImageElement

// ---------- Image loading ----------
function loadImageFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      currentImage = img;
      showBuildStage();
      buildFromImage(img);
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function drawSampleFace() {
  const c = document.createElement("canvas");
  c.width = 200; c.height = 200;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#f5c46a"; ctx.fillRect(0, 0, 200, 200);
  ctx.beginPath(); ctx.arc(100, 105, 80, 0, Math.PI * 2); ctx.fillStyle = "#f7c873"; ctx.fill();
  // hair
  ctx.fillStyle = "#3a2418";
  ctx.beginPath(); ctx.arc(100, 70, 82, Math.PI, 0); ctx.fill();
  ctx.fillRect(18, 60, 164, 25);
  // eyes
  ctx.fillStyle = "#1b1b1b";
  ctx.beginPath(); ctx.arc(70, 110, 9, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(130, 110, 9, 0, Math.PI * 2); ctx.fill();
  // smile
  ctx.strokeStyle = "#7c3d1c"; ctx.lineWidth = 6; ctx.lineCap = "round";
  ctx.beginPath(); ctx.arc(100, 130, 35, 0.2, Math.PI - 0.2); ctx.stroke();
  // cheeks
  ctx.fillStyle = "rgba(224,90,90,0.35)";
  ctx.beginPath(); ctx.arc(55, 140, 12, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(145, 140, 12, 0, Math.PI * 2); ctx.fill();

  const img = new Image();
  img.onload = () => {
    currentImage = img;
    showBuildStage();
    buildFromImage(img);
  };
  img.src = c.toDataURL();
}

function showBuildStage() {
  uploadStage.classList.add("hidden");
  buildStage.classList.remove("hidden");
  if (!renderer) initScene();
  onResize();
}

// ---------- Upload interactions ----------
fileInput.addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (f) loadImageFile(f);
});

["dragenter", "dragover"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  })
);
dropzone.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files[0];
  if (f && f.type.startsWith("image/")) loadImageFile(f);
});

exampleBtn.addEventListener("click", () => drawSampleFace());

newPhotoBtn.addEventListener("click", () => {
  buildStage.classList.add("hidden");
  uploadStage.classList.remove("hidden");
  fileInput.value = "";
});

resolutionInput.addEventListener("input", () => {
  resVal.textContent = resolutionInput.value;
});

rebuildBtn.addEventListener("click", () => {
  if (currentImage) buildFromImage(currentImage);
});

brickHeightInput.addEventListener("input", () => {
  if (currentImage) applyBrickHeights();
});

screenshotBtn.addEventListener("click", () => {
  renderer.render(scene, camera);
  const link = document.createElement("a");
  link.download = "legoify-mosaic.png";
  link.href = renderer.domElement.toDataURL("image/png");
  link.click();
});

// ---------- Pixel sampling ----------
function sampleImageToGrid(img, gridSize) {
  const ctx = sourceCanvas.getContext("2d", { willReadFrequently: true });
  // crop to a centered square first
  const side = Math.min(img.width, img.height);
  const sx = (img.width - side) / 2;
  const sy = (img.height - side) / 2;

  sourceCanvas.width = gridSize;
  sourceCanvas.height = gridSize;
  ctx.imageSmoothingEnabled = true;
  ctx.clearRect(0, 0, gridSize, gridSize);
  ctx.drawImage(img, sx, sy, side, side, 0, 0, gridSize, gridSize);

  const { data } = ctx.getImageData(0, 0, gridSize, gridSize);
  const grid = [];
  for (let y = 0; y < gridSize; y++) {
    const row = [];
    for (let x = 0; x < gridSize; x++) {
      const i = (y * gridSize + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a < 40) { row.push(null); continue; }
      row.push(nearestLegoColor(r, g, b));
    }
    grid.push(row);
  }
  return grid;
}

// ---------- three.js scene ----------
let renderer, scene, camera, controls;
let brickGroup = null;
let brickMeshes = []; // { mesh, targetY, delay }
let clock = new THREE.Clock();
let animActive = false;

const studGeoCache = new Map();
const brickGeoCache = new Map();

function getBrickGeometry(h) {
  const key = h.toFixed(2);
  if (brickGeoCache.has(key)) return brickGeoCache.get(key);
  const geo = new THREE.BoxGeometry(0.94, h, 0.94);
  brickGeoCache.set(key, geo);
  return geo;
}
const studGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.18, 16);

function initScene() {
  const canvas = document.getElementById("scene");
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0c0d11);
  scene.fog = new THREE.Fog(0x0c0d11, 30, 70);

  camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
  camera.position.set(18, 20, 26);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 8;
  controls.maxDistance = 60;
  controls.target.set(0, 0, 0);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x222233, 1.1);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffffff, 1.4);
  dir.position.set(12, 20, 14);
  scene.add(dir);
  const fillLight = new THREE.DirectionalLight(0x99aaff, 0.3);
  fillLight.position.set(-10, 8, -10);
  scene.add(fillLight);

  // base plate
  const plateGeo = new THREE.CylinderGeometry(22, 22, 0.6, 48);
  const plateMat = new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.8 });
  const plate = new THREE.Mesh(plateGeo, plateMat);
  plate.position.y = -0.6;
  scene.add(plate);

  window.addEventListener("resize", onResize);
  animate();
}

function onResize() {
  if (!renderer) return;
  const wrap = document.getElementById("canvasWrap");
  const w = wrap.clientWidth, h = wrap.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  const t = clock.elapsedTime;

  if (animActive) {
    let stillAnimating = false;
    for (const b of brickMeshes) {
      if (t < b.delay) { stillAnimating = true; continue; }
      const progress = Math.min(1, (t - b.delay) / 0.35);
      if (progress < 1) stillAnimating = true;
      const eased = 1 - Math.pow(1 - progress, 3);
      b.mesh.position.y = THREE.MathUtils.lerp(b.startY, b.targetY, eased);
      b.mesh.scale.setScalar(THREE.MathUtils.lerp(0.4, 1, eased));
    }
    if (!stillAnimating) animActive = false;
  }

  if (brickGroup) brickGroup.rotation.y += 0.0009 * (60 * dt);

  controls.update();
  renderer.render(scene, camera);
}

function applyBrickHeights() {
  const h = parseFloat(brickHeightInput.value);
  for (const b of brickMeshes) {
    const scaleY = h / b.baseHeight;
    b.mesh.geometry = getBrickGeometry(h);
  }
}

function buildFromImage(img) {
  loadingOverlay.classList.remove("hidden");
  loadingText.textContent = "Sampling colors…";

  requestAnimationFrame(() => {
    const gridSize = parseInt(resolutionInput.value, 10);
    const grid = sampleImageToGrid(img, gridSize);

    loadingText.textContent = "Snapping bricks in place…";
    requestAnimationFrame(() => {
      buildBricks(grid, gridSize);
      loadingOverlay.classList.add("hidden");
    });
  });
}

function buildBricks(grid, gridSize) {
  if (brickGroup) {
    scene.remove(brickGroup);
    for (const b of brickMeshes) {
      b.mesh.geometry?.dispose?.();
      b.mesh.material?.dispose?.();
    }
  }
  brickMeshes = [];
  brickGroup = new THREE.Group();

  const brickH = parseFloat(brickHeightInput.value);
  const geo = getBrickGeometry(brickH);
  const half = gridSize / 2;
  const materialCache = new Map();
  const colorsUsed = new Set();
  let count = 0;

  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      const c = grid[y][x];
      if (!c) continue;
      colorsUsed.add(c.name);

      let mat = materialCache.get(c.hex);
      if (!mat) {
        mat = new THREE.MeshStandardMaterial({ color: c.hex, roughness: 0.35, metalness: 0.05 });
        materialCache.set(c.hex, mat);
      }

      const mesh = new THREE.Mesh(geo, mat);
      const px = x - half;
      const pz = y - half;
      mesh.position.set(px, brickH / 2, pz);

      const stud = new THREE.Mesh(studGeo, mat);
      stud.position.set(0, brickH / 2 + 0.09, 0);
      mesh.add(stud);

      brickGroup.add(mesh);

      const targetY = brickH / 2;
      const startY = targetY - (2 + Math.random() * 3);
      mesh.position.y = startY;

      const delay = 0.15 + (Math.random() * 0.9) + (Math.hypot(px, pz) / half) * 0.4;
      brickMeshes.push({ mesh, startY, targetY, delay, baseHeight: brickH });
      count++;
    }
  }

  scene.add(brickGroup);
  clock.elapsedTime = 0;
  clock.start();
  animActive = true;

  brickCountEl.textContent = `${count} bricks`;
  colorCountEl.textContent = `${colorsUsed.size} colors`;
}
