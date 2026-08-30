# Legoify

Turn a photo into a 3D brick-built LEGO character you can spin around.

Drop in a photo and it's read for its hair, skin, shirt and trouser colours —
each snapped to the nearest real LEGO brick colour — then a full volumetric
figure is assembled brick by brick in 3D. Drag to rotate it, switch poses,
recolour any part, and save a render.

## How it works

The figure isn't a flat mosaic. A humanoid volume is defined procedurally from
capsules and ellipsoids (legs, hips, torso, arms, neck, head), voxelised onto a
grid, and every surface cell becomes a real brick — studs included, and only
where nothing sits on top. Interior bricks are culled, and the remainder are
drawn as instanced meshes grouped by colour and stud state.

Rendering uses physically-based plastic materials with clearcoat, a generated
studio environment for reflections, and soft shadow mapping onto a
shadow-only ground plane so the page stays pure white.

## Stack

Plain HTML/CSS/JS, no build step. [three.js](https://threejs.org) via CDN
import map. Everything runs client-side — no image ever leaves the browser.

## Run locally

```bash
npx serve .
```

## Deploy

Static site — deploys as-is to Vercel or any static host, no config needed.
