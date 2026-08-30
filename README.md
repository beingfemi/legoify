# Legoify

Turn a photo into 3D LEGO you can spin around. Two different builders, sharing
one brick renderer.

| | | |
|---|---|---|
| **Character** | `/` | Builds a brick-built figure in your photo's colours. Poses, editable palette. |
| **Likeness** | `/depth` | Runs a depth model on your photo and rebuilds its *actual* 3D shape. |

## Character builder (`/`)

The photo supplies the palette, not the shape. Hair, skin, shirt and trouser
colours are read from four regions of the image and snapped to the nearest real
LEGO colour; the figure itself is a procedural humanoid volume built from
capsules and ellipsoids (legs, hips, torso, arms, neck, head), voxelised and
rebuilt in bricks. Stand / point / cheer poses, and every body part is
recolourable from the palette.

## Likeness builder (`/depth`)

True photo-to-3D. [Depth Anything V2 Small](https://huggingface.co/onnx-community/depth-anything-v2-small)
runs **in the browser** via `@huggingface/transformers` (WebGPU where available,
WASM otherwise). Its depth map becomes a heightfield: each grid cell protrudes
by its depth, gets a flattened mirrored back so the result is a solid bust
rather than a flat plaque, and takes its colour from the photo.

Three controls: **Detail** (grid resolution), **Depth** (relief exaggeration)
and **Cutout** (the depth threshold that separates subject from background).
The depth map itself is shown top-right.

The model is ~25 MB and downloads once, then is cached by the browser.

Caveat worth knowing: a depth model only sees the front of the subject, so the
back is an approximation, not measured geometry.

## Shared renderer (`brickscene.js`)

Both builders hand a `Map` of `"x,y,z" → colour` to the same renderer, which:

- culls fully-enclosed bricks and keeps only the visible shell
- groups the remainder by colour and by whether a stud shows, drawing each
  group as one `InstancedMesh`
- adds a stud only where nothing sits on top
- animates the build, brick by brick, from above
- fits the camera and shadow frustum to whatever it was given

Colour matching uses a redmean-weighted distance plus a saturation penalty, so
near-neutral pixels land on greys and whites instead of being dragged onto a
saturated brick (which is how white turns pink).

### Making it read as plastic

Two layers of ambient occlusion, because without them an assembly looks like
painted blocks rather than moulded plastic:

- **Baked**, for the large crevices. The model is voxels, so the occlusion of
  each brick is known exactly — it's computed from weighted neighbour occupancy
  and rides along as a per-instance colour multiplier. No post-processing.
- **GTAO**, for the fine detail baked AO cannot reach: the shading around every
  stud base and brick seam.

Ambient light is kept deliberately low (0.14) so that occlusion isn't washed
out. Materials are physically-based ABS — clearcoat 1.0 over a 0.30-roughness
base — lit by a generated studio environment.

Two things this setup needs care with:

- The canvas is **transparent** over the page's white. ACES tone mapping maps
  pure white to ~0.81, so a white clear colour inside the composer renders grey;
  keeping the background out of the 3D layer entirely avoids it.
- The shadow-catcher plane is hidden during the AO prepass, or GTAO shades the
  infinite ground and greys the whole page.

The near/far planes track camera distance every frame — snug enough for a
precise AO prepass, never so snug that zooming in clips into the model.

Character eyes are printed round tiles (a canvas-generated texture on a
cylinder cap), not flat bricks.

## Stack

Plain HTML/CSS/JS, no build step. [three.js](https://threejs.org) and
transformers.js via CDN. Everything runs client-side — no image ever leaves
the browser.

## Run locally

```bash
npx serve .
```

## Deploy

Static site — deploys as-is to Vercel or any static host.
