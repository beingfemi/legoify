// Photo → true 3D likeness.
// A monocular depth model (Depth Anything V2) runs in the browser; its depth map
// becomes a heightfield that is voxelised and rebuilt in bricks.
import { BrickScene, snapToLego } from "./brickscene.js";

const TRANSFORMERS = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5/dist/transformers.min.js";
const MODEL = "onnx-community/depth-anything-v2-small";

const uploadStage = document.getElementById("uploadStage");
const buildStage = document.getElementById("buildStage");
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const loadingEl = document.getElementById("loading");
const loadingText = document.getElementById("loadingText");
const bar = document.querySelector("#bar i");
const tallyEl = document.getElementById("brickTally");
const depthPreview = document.getElementById("depthPreview");
const srcCanvas = document.getElementById("sourceCanvas");

const detailInput = document.getElementById("detail");
const reliefInput = document.getElementById("relief");
const cutoutInput = document.getElementById("cutout");

let scene = null;
let depther = null;       // the loaded pipeline
let source = null;        // { color: ImageData(S×S), depth: Float32Array(S×S) }
const S = 256;            // working resolution for sampling

// ───────────────────────── model ─────────────────────────
async function getDepther() {
  if (depther) return depther;
  loadingText.textContent = "Downloading depth model (~25 MB, first time only)…";
  const { pipeline } = await import(TRANSFORMERS);
  depther = await pipeline("depth-estimation", MODEL, {
    dtype: "q8",
    progress_callback: (p) => {
      if (p.status === "progress" && p.total) {
        const pct = Math.round((p.loaded / p.total) * 100);
        bar.style.width = pct + "%";
        loadingText.textContent = `Downloading depth model… ${pct}%`;
      }
    },
  });
  bar.style.width = "100%";
  return depther;
}

// ───────────────────────── analysis ─────────────────────────
async function analyse(img) {
  const ctx = srcCanvas.getContext("2d", { willReadFrequently: true });
  const side = Math.min(img.width, img.height);
  srcCanvas.width = srcCanvas.height = S;
  ctx.clearRect(0, 0, S, S);
  ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S, S);
  const color = ctx.getImageData(0, 0, S, S);

  const pipe = await getDepther();
  loadingText.textContent = "Estimating depth…";
  await new Promise((r) => setTimeout(r, 16));

  const out = await pipe(srcCanvas.toDataURL("image/png"));
  const dm = out.depth;                       // RawImage, 1 channel, near = bright

  // Resample the model's depth map to S×S floats in 0..1.
  const raw = new Float32Array(S * S);
  let lo = Infinity, hi = -Infinity;
  for (let y = 0; y < S; y++) {
    const sy = Math.min(dm.height - 1, Math.round((y / S) * dm.height));
    for (let x = 0; x < S; x++) {
      const sx = Math.min(dm.width - 1, Math.round((x / S) * dm.width));
      const v = dm.data[(sy * dm.width + sx) * dm.channels];
      raw[y * S + x] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < raw.length; i++) raw[i] = (raw[i] - lo) / span;

  source = { color, depth: blur(raw, S, 1) };
  showDepthPreview(source.depth);
}

// Small box blur — takes the stair-stepping out of the quantised relief.
function blur(src, size, radius) {
  const out = new Float32Array(src.length);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0, n = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= size) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= size) continue;
          sum += src[yy * size + xx]; n++;
        }
      }
      out[y * size + x] = sum / n;
    }
  }
  return out;
}

function showDepthPreview(depth) {
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d");
  const im = g.createImageData(S, S);
  for (let i = 0; i < depth.length; i++) {
    const v = Math.round(depth[i] * 255);
    im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = v;
    im.data[i * 4 + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  depthPreview.src = c.toDataURL();
}

// ───────────────────────── voxelise ─────────────────────────
function buildVoxels() {
  const N = parseInt(detailInput.value, 10);        // grid cells across
  const relief = parseInt(reliefInput.value, 10);   // max protrusion, in bricks
  const cutout = parseInt(cutoutInput.value, 10) / 100;

  const { color, depth } = source;
  const vox = new Map();
  const half = Math.floor(N / 2);

  // Average the S×S maps down into each N×N cell.
  const step = S / N;
  for (let gy = 0; gy < N; gy++) {
    for (let gx = 0; gx < N; gx++) {
      const x0 = Math.floor(gx * step), x1 = Math.max(x0 + 1, Math.floor((gx + 1) * step));
      const y0 = Math.floor(gy * step), y1 = Math.max(y0 + 1, Math.floor((gy + 1) * step));

      let d = 0, r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * S + x;
          d += depth[i];
          r += color.data[i * 4]; g += color.data[i * 4 + 1]; b += color.data[i * 4 + 2];
          n++;
        }
      }
      d /= n;
      if (d < cutout) continue;                     // background — leave it out

      // Re-map so the cutout point sits at zero thickness.
      const h = (d - cutout) / Math.max(0.001, 1 - cutout);
      const front = Math.max(0, Math.round(h * relief));
      const back = Math.max(0, Math.round(front * 0.55));   // flattened mirrored back
      const hex = snapToLego(r / n, g / n, b / n);

      const ix = gx - half;
      const iy = N - 1 - gy;                        // image y grows downward
      for (let iz = -back; iz <= front; iz++) vox.set(`${ix},${iy},${iz}`, hex);
    }
  }
  return vox;
}

function rebuild() {
  if (!source) return;
  loadingEl.classList.remove("hidden");
  loadingText.textContent = "Laying bricks…";
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const n = scene.setVoxels(buildVoxels());
    tallyEl.textContent = `${n.toLocaleString()} bricks`;
    loadingEl.classList.add("hidden");
  }));
}

// ───────────────────────── flow ─────────────────────────
async function handleFile(file) {
  loadingEl.classList.remove("hidden");
  bar.style.width = "0%";
  try {
    const img = await readImage(file);
    await analyse(img);
    uploadStage.classList.add("hidden");
    buildStage.classList.remove("hidden");
    if (!scene) scene = new BrickScene(document.getElementById("scene"));
    else scene.resize();
    rebuild();
  } catch (err) {
    console.error(err);
    loadingText.textContent = "Couldn't process that image — try another.";
    setTimeout(() => loadingEl.classList.add("hidden"), 2500);
  }
}

function readImage(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = (e) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = e.target.result;
    };
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
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

let debounce;
[detailInput, reliefInput, cutoutInput].forEach((el) =>
  el.addEventListener("input", () => { clearTimeout(debounce); debounce = setTimeout(rebuild, 180); }));

document.getElementById("replayBtn").addEventListener("click", () => scene?.replay());
document.getElementById("shotBtn").addEventListener("click", () => scene?.snapshot("legoify-likeness.png"));
document.getElementById("newBtn").addEventListener("click", () => {
  buildStage.classList.add("hidden");
  uploadStage.classList.remove("hidden");
  fileInput.value = "";
});

// Warm the model up while the user is still choosing a photo.
getDepther().catch(() => {});
