// Photo → a brick-built LEGO character.
// The photo supplies the palette; the figure is a procedural humanoid volume.
import * as THREE from "three";
import { BrickScene, PALETTE, snapToLego, BH } from "./brickscene.js";

// Character colours, sampled from the photo (and user-editable).
let COLORS = { hair: 0x5c3c2e, skin: 0xd0956a, shirt: 0xc4281c, pants: 0x1e2f5c, shoe: 0x1b1b1b };
const SWATCH_KEYS = ["hair", "skin", "shirt", "pants", "shoe"];
const SWATCH_LABELS = { hair: "Hair", skin: "Skin", shirt: "Shirt", pants: "Legs", shoe: "Shoes" };
const EYE = 0x1b1b1b;

// ─────────────────── Photo → character colours ───────────────────
const srcCanvas = document.getElementById("sourceCanvas");

// Most-common LEGO colour inside a normalised region of the image.
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

// ─────────────────────── Geometry helpers ───────────────────────
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

// ─────────────────────── Character model ───────────────────────
// Grid indices; world = (ix, iy*BH, iz). Figure stands on y = 0.
const GX = 16, GY = 48, GZ = 11;

const SHOULDER_Y = 37.6;
const SHOULDER_X = 7.2;

const POSES = {
  stand: { L: [-9.6, 24.5, 1.0], R: [9.6, 24.5, 1.0] },
  point: { L: [-9.6, 24.5, 1.0], R: [11.8, 55.0, 1.8] },
  cheer: { L: [-11.8, 55.0, 1.8], R: [11.8, 55.0, 1.8] },
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
        const x = ix, y = iy * BH, z = iz;
        let c = null;

        // legs — kept far enough apart to leave a real gap
        for (const sx of [-3.9, 3.9]) {
          if (distToSegment(x, y, z, sx, 22.0, 0, sx, 4.2, 0) <= 2.9) c = COLORS.pants;
        }
        // feet
        for (const sx of [-3.9, 3.9]) {
          if (inEllipsoid(x, y, z, sx, 1.8, 1.8, 3.0, 1.9, 4.7)) c = COLORS.shoe;
        }
        // hips
        if (inEllipsoid(x, y, z, 0, 22.6, 0, 6.0, 4.0, 4.3)) c = COLORS.pants;

        // torso — tapered ellipse per height
        if (y >= 23.0 && y <= 38.8) {
          const t = (y - 23.0) / 15.8;
          const rx = THREE.MathUtils.lerp(5.4, 7.5, t);
          const rz = THREE.MathUtils.lerp(3.9, 5.1, t);
          if ((x / rx) ** 2 + (z / rz) ** 2 <= 1) c = COLORS.shirt;
        }

        // arms — shoulder → elbow → hand, sleeve on the upper half
        for (const { sx, hand } of arms) {
          const ex = (sx + hand[0]) / 2 + Math.sign(sx) * 1.4;
          const ey = (SHOULDER_Y + hand[1]) / 2;
          const ez = hand[2] / 2;
          const dUp = distToSegment(x, y, z, sx, SHOULDER_Y, 0, ex, ey, ez);
          const dLo = distToSegment(x, y, z, ex, ey, ez, hand[0], hand[1], hand[2]);
          if (dUp <= 2.6) c = COLORS.shirt;
          if (dLo <= 2.25) c = COLORS.skin;
          if (inEllipsoid(x, y, z, hand[0], hand[1], hand[2], 2.7, 2.7, 2.7)) c = COLORS.skin;
        }

        // neck + head
        if (distToSegment(x, y, z, 0, 38.6, 0, 0, 42.4, 0) <= 2.9) c = COLORS.skin;
        if (inEllipsoid(x, y, z, 0, 47.4, 0, 6.9, 7.4, 6.6)) {
          c = COLORS.skin;
          // hair: crown + back, wrapping down the sides but never over the face
          const crown = y >= 49.6;
          const back = z <= -2.2 && y >= 44.0;
          const sides = Math.abs(x) >= 5.2 && z <= 1.6 && y >= 44.5;
          if (crown || back || sides) c = COLORS.hair;
        }

        if (c !== null) vox.set(key(ix, iy, iz), c);
      }
    }
  }

  addFace(vox, key);
  return vox;
}

// Eyes, nose and mouth: recolour the frontmost voxel of the head at set heights.
function addFace(vox, key) {
  const frontmost = (ix, iy) => {
    for (let iz = GZ; iz >= -GZ; iz--) if (vox.has(key(ix, iy, iz))) return iz;
    return null;
  };
  const row = (worldY) => Math.round(worldY / BH);

  const eyeRow = row(48.4);
  for (const ix of [-4, -3, 3, 4]) {
    const iz = frontmost(ix, eyeRow);
    if (iz !== null) vox.set(key(ix, eyeRow, iz), EYE);
  }
  const noseRow = row(46.0);
  const noseZ = frontmost(0, noseRow);
  if (noseZ !== null) vox.set(key(0, noseRow, noseZ + 1), COLORS.skin);
  const mouthRow = row(43.0);
  for (const ix of [-1, 0, 1]) {
    const iz = frontmost(ix, mouthRow);
    if (iz !== null) vox.set(key(ix, mouthRow, iz), 0x5c3c2e);
  }
}

// ─────────────────────────── UI ───────────────────────────
let scene = null;

const uploadStage = document.getElementById("uploadStage");
const buildStage = document.getElementById("buildStage");
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const swatchesEl = document.getElementById("swatches");
const popEl = document.getElementById("palettePop");
const loadingEl = document.getElementById("loading");
const tallyEl = document.getElementById("brickTally");

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
      rebuild();
    });
    popEl.appendChild(b);
  }
  popEl.classList.remove("hidden");
  const r = anchor.getBoundingClientRect();
  popEl.style.left = Math.max(8, Math.min(r.left - 60, innerWidth - 200)) + "px";
  popEl.style.top = r.top - popEl.offsetHeight - 10 + "px";
}
addEventListener("click", () => popEl.classList.add("hidden"));

function rebuild() {
  const n = scene.setVoxels(buildVoxels());
  tallyEl.textContent = `${n.toLocaleString()} bricks`;
}

function enterBuild() {
  uploadStage.classList.add("hidden");
  buildStage.classList.remove("hidden");
  loadingEl.classList.remove("hidden");
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!scene) scene = new BrickScene(document.getElementById("scene"));
    else scene.resize();
    rebuild();
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
  rebuild();
});

document.getElementById("replayBtn").addEventListener("click", () => scene?.replay());
document.getElementById("shotBtn").addEventListener("click", () => scene?.snapshot("legoify-character.png"));
document.getElementById("newBtn").addEventListener("click", () => {
  buildStage.classList.add("hidden");
  uploadStage.classList.remove("hidden");
  fileInput.value = "";
});

renderSwatches();
