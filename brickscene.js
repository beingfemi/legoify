// Shared brick renderer: palette, voxel → instanced bricks, lighting, assembly.
// Used by both the character builder (app.js) and the depth likeness (depth.js).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";

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

const brickPlain = new RoundedBoxGeometry(BW * 0.98, BH * 0.98, BW * 0.98, 2, 0.055).toNonIndexed();
const studGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.24, 18).toNonIndexed();
studGeo.translate(0, BH * 0.49 + 0.11, 0);
const brickStudded = BufferGeometryUtils.mergeGeometries([brickPlain, studGeo], false);

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

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setClearColor(0xffffff, 1);
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

    const rim = new THREE.DirectionalLight(0xffffff, 0.7);
    rim.position.set(-34, 26, -32);
    scene.add(rim);
    scene.add(new THREE.AmbientLight(0xffffff, 0.35));

    // Shadow-only ground keeps the page pure white.
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(600, 600),
      new THREE.ShadowMaterial({ opacity: 0.17 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    this._onResize = () => this.resize();
    addEventListener("resize", this._onResize);
    this.resize();
    renderer.setAnimationLoop(() => this._tick());
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.figure) this.fitCamera();
  }

  // vox: Map keyed "x,y,z" (grid indices) → colour hex.
  setVoxels(vox) {
    if (this.figure) {
      this.scene.remove(this.figure);
      this.figure.traverse((o) => {
        if (o.isInstancedMesh) { o.material.dispose?.(); }
      });
    }
    this.figure = new THREE.Group();
    this.anims = [];

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
    let total = 0;
    for (const { color, studded, cells } of buckets.values()) {
      const mat = new THREE.MeshPhysicalMaterial({
        color, roughness: 0.38, metalness: 0.0,
        clearcoat: 0.55, clearcoatRoughness: 0.28,
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
        this.anims.push({
          mesh, i, target,
          from: target.y + 16 + Math.random() * 22,
          delay: 0.16 + (y / maxY) * 0.75 + Math.random() * 0.28,
        });
        total++;
      });
      mesh.instanceMatrix.needsUpdate = true;
      this.figure.add(mesh);
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
    this.controls.update();

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

  replay() {
    this.animStart = performance.now() / 1000;
    this.animating = true;
  }

  snapshot(filename = "legoify.png") {
    this.renderer.render(this.scene, this.camera);
    const a = document.createElement("a");
    a.download = filename;
    a.href = this.renderer.domElement.toDataURL("image/png");
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
      this.animating = busy;
    }

    if (this.figure && !this.userTouched && !this.animating) this.figure.rotation.y += 0.0018;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
