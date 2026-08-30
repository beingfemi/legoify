# Legoify

Turn any photo into an interactive 3D LEGO mosaic — right in the browser.

Upload (or drag & drop) a photo, and it's downsampled, snapped to the
closest official LEGO brick colors, and rebuilt brick-by-brick in a live
3D scene. Drag to rotate, scroll to zoom, and take a snapshot when it looks
good.

## Stack

Plain HTML/CSS/JS — no build step. 3D rendering via [three.js](https://threejs.org)
loaded from a CDN through an import map. Everything (image sampling, color
quantization, rendering) runs client-side; no image is ever uploaded anywhere.

## Run locally

Just serve the folder statically, e.g.:

```bash
npx serve .
```

Then open the printed local URL.

## Deploy

Static site — deploys as-is to Vercel (or any static host), no config needed.
