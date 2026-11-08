# Revenue Media Lab reconstruction

A static, evidence-backed reconstruction of <https://revenuemedialab.com/>, captured and built on 2026-11-08. The source runtime has been removed; the seven routes are local HTML with localized CSS, fonts, and media, plus a source-derived motion layer.

## Serve

```bash
node serve.mjs
# http://127.0.0.1:4310
```

Set `PORT` to use another port. The checked-in site is in `site/`; `serve.mjs` serves it with directory-index and route fallbacks. No npm install is required.

## Layout

- `site/` — the built seven-route site, including 393 local assets.
- `build.mjs` — rebuilds `site/` from a frozen source capture.
- `runtime.js`, `motion.js`, `easing.js` — navigation/controls, scroll-driven motion, and sampled source easings.
- `pipe-geometry.js`, `pipe-render.js` — source-derived responsive pipe geometry and SVG rendering.
- `evidence/` — source pipe snapshots retained as supporting evidence.
- `build-report.json` — page and asset counts from the checked-in build.

## Verification

The reconstruction was verified against the live source and the frozen capture before extraction:

- **7/7** routes load directly with working links and history; **6/7 verified, 1 review, 0 failed/blocked**. The review is the homepage's known empty-text geometry wrapper.
- **77/77** responsive checks pass at 11 widths, with **21/21** primary screenshots at 640, 1024, and 1180 exact.
- **9/9** live geometry widths match exactly: 390, 500, 640, 768, 900, 1024, 1100, 1180, and 1440 px.
- **12/12** motion baselines are pinned; all reduced-motion states are pixel-exact, and the largest no-preference residual is **0.8263%** on the mobile post card from split transform rasterization.
- The full toolkit suite passed **64/64**, and the reconstruction tests passed **5/5**.
- The instant-jump trigger gate is **±25 ms**, enforced by the parent toolkit over three timing runs per state. Final medians: desktop **807.8/816.6 ms** (source/clone, +8.8 ms), mobile first card **458.0/457.7 ms** (−0.3 ms), and mobile second card **458.1/457.6 ms** (−0.5 ms). The widest per-origin spread was **8.4 ms**; the old section-trigger behavior fails the gate by **345.6 ms**.

Tablet/intermediate motion profiles were intentionally omitted; those widths are covered by the geometry comparison and responsive audit, not by motion screenshots or timing samples.

## Rebuild

Rebuilding requires the frozen capture used for the original build, which is not included here:

```bash
MANIFEST=/path/to/frozen/evidence/routes.json node build.mjs
```

The build reads the manifest and captured route HTML, fetches and localizes referenced assets from the authorized source, and writes `site/`. The checked-in `site/` is already built and can be served without the capture.

## Scope and rights

This reconstruction was produced for authorized analysis and review. It is not affiliated with Revenue Media Lab and does not grant rights to the source's trademarks, copy, photography, or other protected assets. Do not deploy it as a production replacement.
