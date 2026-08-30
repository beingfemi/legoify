// Shared brick renderer: palette, voxel → instanced bricks, lighting, assembly.
// Used by both the character builder (app.js) and the depth likeness (depth.js).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

export const PALETTE = [
  0xf4f4f4, 0xe6e3da, 0xc9cbc8, 0xa3a2a4, 0x898788, 0x635f61, 0x2b2b2c,
  0x1b1b1b, 0xc4281c, 0x7c0a02, 0xe3691c, 0xb04a2f, 0xf5c400, 0xfbe6a2,
  0x237841, 0x4b9f4c, 0x789082, 0x0055bf, 0x4c7fd6, 0x1e2f5c, 0x7a4bab,
  0x923978, 0xe4adc8, 0xd0956a, 0xe4cd9e, 0xaa7f56, 0x5c3c2e, 0x958a73,
];

const sat = (r, g, b) => {
  const mx = Math.max(r, g, b);
  return mx === 0 ? 0 : (mx - Math.min(r, g, b)) / mx;
};

const PAL_RGB = PALETTE.map((h) => {
  const r = (h >> 16) & 255, g = (h >> 8) & 255, b = h & 255;
  return { hex: h, r, g, b, s: sat(r, g, b) };
});

// Nearest brick colour, weighted so that a near-neutral pixel is not dragged
// onto a saturated brick (which is how white turns pink).
export function snapToLego(r, g, b) {
  const s = sat(r, g, b);
  let best = PAL_RGB[0], bd = Infinity;
  for (const c of PAL_RGB) {
    const rm = (r + c.r) / 2;
    const dr = r - c.r, dg = g - c.g, db = b - c.b;
    let d = (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
    const over = Math.max(0, c.s - s);          // brick more colourful than the pixel
    d += over * over * 26000;
    if (d < bd) { bd = d; best = c; }
  }
  return best.hex;
}

// Brick footprint is square; height is the usual 1.2× the width.
export const BW = 1.0;
export const BH = 1.2;

const brickPlain = new RoundedBoxGeometry(BW * 0.97, BH * 0.97, BW * 0.97, 3, 0.045).toNonIndexed();
// Real studs taper very slightly and have a softened top edge.
const studGeo = new THREE.CylinderGeometry(0.292, 0.303, 0.25, 24).toNonIndexed();
studGeo.translate(0, BH * 0.485 + 0.115, 0);
const brickStudded = BufferGeometryUtils.mergeGeometries([brickPlain, studGeo], false);

// Analytic ambient occlusion. Because the model is voxels we know exactly what
// surrounds each brick, so crevices can be darkened without any post-processing.
const AO_OFFSETS = (() => {
  const R = 2, out = [];
  for (let dz = -R; dz <= R; dz++)
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        if (!dx && !dy && !dz) continue;
        const d = Math.hypot(dx, dy, dz);
        if (d > R + 0.25) continue;
        out.push([dx, dy, dz, 1 / d]);
      }
  return out;
})();
const AO_WTOTAL = AO_OFFSETS.reduce((s, o) => s + o[3], 0);

// An unoccluded flat wall sits near 0.5; anything above that is a crevice.
// Kept moderate: this handles the large-scale crevices, GTAO does the fine
// detail around stud bases and brick seams.
const AO_KNEE = 0.46;
const AO_STRENGTH = 0.80;
const AO_FLOOR = 0.42;

function occlusionAt(vox, x, y, z) {
  let occ = 0;
  for (let i = 0; i < AO_OFFSETS.length; i++) {
    const o = AO_OFFSETS[i];
    if (vox.has(`${x + o[0]},${y + o[1]},${z + o[2]}`)) occ += o[3];
  }
  const ratio = occ / AO_WTOTAL;
  const t = Math.max(0, ratio - AO_KNEE) / (1 - AO_KNEE);
  return Math.max(AO_FLOOR, 1 - AO_STRENGTH * t);
}

export class BrickScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.figure = null;
    this.anims = [];
    this.animating = false;
    this.animStart = 0;
    this.userTouched = false;
    this.brickCount = 0;
    this._dummy = new THREE.Object3D();

    // Transparent canvas over the page's white: keeps the background out of the
    // tone mapper, which would otherwise render pure white as ~0.81 grey.
    const renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, alpha: true, preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer = renderer;

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene = scene;

    this.camera = new THREE.PerspectiveCamera(34, 1, 0.5, 900);
    this.camera.position.set(30, 26, 88);

    const controls = new OrbitControls(this.camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.target.set(0, 22, 0);
    controls.addEventListener("start", () => { this.userTouched = true; });
    this.controls = controls;

    const key = new THREE.DirectionalLight(0xffffff, 2.6);
    key.position.set(26, 64, 42);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.radius = 3;
    key.shadow.bias = -0.0002;
    key.shadow.normalBias = 0.55;
    scene.add(key);
    this.keyLight = key;

    const rim = new THREE.DirectionalLight(0xffffff, 0.6);
    rim.position.set(-34, 26, -32);
    scene.add(rim);
    // Kept low on purpose — a strong ambient fill washes the baked AO out.
    scene.add(new THREE.AmbientLight(0xffffff, 0.14));

    // Shadow-only ground keeps the page pure white.
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(600, 600),
      new THREE.ShadowMaterial({ opacity: 0.17 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // Ground-truth ambient occlusion around stud bases and brick seams — the
    // detail that makes an assembly read as plastic rather than painted blocks.
    const composer = new EffectComposer(renderer);
    const renderPass = new RenderPass(scene, this.camera);
    renderPass.clearAlpha = 0;
    composer.addPass(renderPass);
    const gtao = new GTAOPass(scene, this.camera, innerWidth, innerHeight);
    gtao.output = GTAOPass.OUTPUT.Default;
    gtao.blendIntensity = 0.85;
    gtao.updateGtaoMaterial({
      radius: 0.62, distanceExponent: 1, thickness: 1.4,
      scale: 1.0, samples: 16, distanceFallOff: 1, screenSpaceRadius: false,
    });
    gtao.updatePdMaterial({
      lumaPhi: 10, depthPhi: 2, normalPhi: 3,
      radius: 3, radiusExponent: 1, rings: 2, samples: 8,
    });
    // The shadow-catcher plane must stay out of the AO prepass, or GTAO shades
    // the infinite ground and the white page turns grey.
    const gtaoRender = gtao.render.bind(gtao);
    gtao.render = (...args) => {
      ground.visible = false;
      gtaoRender(...args);
      ground.visible = true;
    };

    composer.addPass(gtao);
    composer.addPass(new OutputPass());
    this.composer = composer;
    this.gtao = gtao;

    this._onResize = () => this.resize();
    addEventListener("resize", this._onResize);
    this.resize();
    renderer.setAnimationLoop(() => this._tick());
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.gtao.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.figure) this.fitCamera();
  }

  // vox: Map keyed "x,y,z" (grid indices) → colour hex.
  // details: optional Object3D of non-brick parts (printed eyes, etc.) that
  // should ride along with the model and fade in once it is built.
  setVoxels(vox, details = null) {
    if (this.figure) {
      this.scene.remove(this.figure);
      this.figure.traverse((o) => {
        if (o.isMesh || o.isInstancedMesh) {
          o.geometry?.dispose?.();
          if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose?.());
          else o.material?.dispose?.();
        }
      });
    }
    this.figure = new THREE.Group();
    this.anims = [];
    this.details = details;

    const has = (x, y, z) => vox.has(`${x},${y},${z}`);

    // Keep only surface bricks; bucket by colour + whether a stud shows.
    const buckets = new Map();
    let maxY = 1;
    for (const [k, color] of vox) {
      const [x, y, z] = k.split(",").map(Number);
      if (y > maxY) maxY = y;
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

    const dummy = this._dummy;
    const tint = new THREE.Color();
    let total = 0;
    for (const { color, studded, cells } of buckets.values()) {
      const mat = new THREE.MeshPhysicalMaterial({
        color, roughness: 0.30, metalness: 0.0,
        clearcoat: 1.0, clearcoatRoughness: 0.14,
        envMapIntensity: 1.15,
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

        // Baked AO rides along as a per-instance multiplier on the brick colour.
        const ao = occlusionAt(vox, x, y, z);
        mesh.setColorAt(i, tint.setRGB(ao, ao, ao));

        this.anims.push({
          mesh, i, target,
          from: target.y + 16 + Math.random() * 22,
          delay: 0.16 + (y / maxY) * 0.75 + Math.random() * 0.28,
        });
        total++;
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.figure.add(mesh);
    }

    if (details) {
      details.scale.setScalar(0.001);
      this.figure.add(details);
    }

    this.scene.add(this.figure);
    this.brickCount = total;
    this.fitCamera();
    this.replay();
    return total;
  }

  // Frame the whole model, keeping whatever direction the user is viewing from.
  fitCamera() {
    const box = new THREE.Box3().setFromObject(this.figure);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const fitH = size.y / (2 * Math.tan(fov / 2));
    const fitW = size.x / (2 * Math.tan(fov / 2) * this.camera.aspect);
    const dist = Math.max(fitH, fitW) * 1.32;

    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(0.34, 0.2, 1);
    dir.normalize();

    // lift the model slightly so the dock never covers its feet
    center.y -= size.y * 0.05;
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.controls.minDistance = dist * 0.3;
    this.controls.maxDistance = dist * 3.5;
    this._radius = size.length() * 0.5;
    this.controls.update();
    this._updateClip();

    // keep the shadow frustum snug around the model
    const r = Math.max(size.x, size.z) * 0.75 + size.y * 0.35;
    const cam = this.keyLight.shadow.camera;
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
    cam.near = 1; cam.far = r * 6 + 100;
    cam.updateProjectionMatrix();
    this.keyLight.position.set(center.x + r * 0.5, r * 1.5, center.z + r * 0.8);
    this.keyLight.target.position.set(center.x, center.y * 0.5, center.z);
    this.keyLight.target.updateMatrixWorld();
    this.scene.add(this.keyLight.target);
  }

  // Keep the depth range snug around the model at whatever zoom the user is at:
  // wide enough never to clip it, tight enough for a precise AO prepass.
  _updateClip() {
    if (!this._radius) return;
    const d = this.camera.position.distanceTo(this.controls.target);
    const near = Math.max(0.1, d - this._radius * 1.6);
    const far = d + this._radius * 3.5;
    if (near !== this.camera.near || far !== this.camera.far) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
  }

  replay() {
    this.animStart = performance.now() / 1000;
    this.animating = true;
  }

  snapshot(filename = "legoify.png") {
    this.composer.render();
    // The canvas is transparent, so flatten onto white before saving.
    const src = this.renderer.domElement;
    const out = document.createElement("canvas");
    out.width = src.width;
    out.height = src.height;
    const g = out.getContext("2d");
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, out.width, out.height);
    g.drawImage(src, 0, 0);

    const a = document.createElement("a");
    a.download = filename;
    a.href = out.toDataURL("image/png");
    a.click();
  }

  _tick() {
    if (this.animating) {
      const t = performance.now() / 1000 - this.animStart;
      const dummy = this._dummy;
      let busy = false;
      const touched = new Set();
      for (const a of this.anims) {
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

      // Printed parts settle in just after the last brick lands.
      if (this.details) {
        const p = THREE.MathUtils.clamp((t - 1.15) / 0.45, 0, 1);
        const e = 1 - Math.pow(1 - p, 3);
        this.details.scale.setScalar(Math.max(0.001, e));
      }
      this.animating = busy;
    }

    if (this.figure && !this.userTouched && !this.animating) this.figure.rotation.y += 0.0018;
    this.controls.update();
    this._updateClip();
    this.composer.render();
  }
}
