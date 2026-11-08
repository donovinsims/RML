# Revenue Media Lab reconstruction

A standalone static reconstruction of <https://revenuemedialab.com/>, built from the frozen capture in `capture/` and verified from this repository alone. The source application scripts are removed; the seven routes are local HTML with localized CSS, fonts, and media, plus a source-derived motion layer and static fallbacks.

## Quick start

```bash
npm install
PLAYWRIGHT_BROWSERS_PATH="$PWD/.pw-browsers" npx playwright install chromium
npm run build
npm run serve
# http://127.0.0.1:4310
```

Set `PORT` to serve on another port. The checked-in `site/` is already built and can be served without rebuilding. `npm install` is only needed for rebuilding, tests, and audits.

## Commands

```bash
npm run build       # rebuild site/ from capture/evidence/routes.json
npm run serve       # serve site/ on http://127.0.0.1:4310
npm test            # pipe geometry, structural matching, static controls, and alignment
npm run audit       # live 11-width responsive audit plus 9-width pipe comparison
npm run benchmark   # fixture and authorized-source discovery/capture/verification
```

The browser commands use the local Chromium installation:

```bash
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.pw-browsers"
npm test
npm run audit
npm run benchmark
```

`npm run audit` starts the local site server itself. `npm test` starts a separate site server on port 4328. `npm run benchmark` starts fixture servers and a local clone server, then writes measured evidence to `.benchmark/` and a compact committed summary to `docs/benchmark-results.json`. The external leg fetches `https://revenuemedialab.com/`; it requires network access and uses only that authorized origin.

## Layout

- `site/` — the built seven-route site, including 393 local assets.
- `capture/` — frozen source route HTML and the manifest used by `build.mjs` and the audit.
- `build.mjs` — rebuilds `site/` from the frozen capture, localizing referenced assets from the authorized source.
- `runtime.js`, `motion.js`, `easing.js` — navigation/controls, scroll-driven motion, and sampled source easings.
- `pipe-geometry.js`, `pipe-render.js` — source-derived responsive pipe geometry and SVG rendering.
- `lib/` — the vendored browser capture, screenshot comparison, discovery, and verification helpers used by local scripts.
- `benchmark/` — standalone benchmark runner, deterministic multipage/SPA fixture, and the vendored workflow under `benchmark/workflow/`.
- `scripts/` — responsive audit and live pipe-geometry comparison.
- `tests/` — golden geometry, structural matcher, static-fallback, and alignment regression tests.
- `docs/` — benchmark report and compact measured results.
- `build-report.json` — page, asset, and failure counts from the checked-in build.

## Verification

The checked-in build is produced from `capture/` with:

- **7** routes, **393** localized assets, **9,697,279** asset bytes, and **0** build failures.
- **5/5** local regression tests passing, including result-card action alignment at 375-1440 px, wrapped attribution icons, 44 px tap height, the initial mobile carousel state, the case-study meta strip, and the expanded back-link hit area.
- **77/77** responsive checks passing across seven routes and eleven widths, including the pipe-geometry widths 390, 500, 640, 768, 900, 1024, 1100, 1180, and 1440 px. **20/21** primary screenshots are exact; the only non-zero primary comparison is the home page at 640 px (**0.0412%**, 2,642 pixels, confined to the three result cards). Home at 1024 px and 1180 px remains exact because the card heights already matched and the attribution rows did not wrap. All primary page-height deltas are zero, and horizontal overflow is zero across all 77 checks; the maximum page-height delta across the full sweep is 1 px (software-founder at 768 px, from the case-study meta-icon alignment), within the audit's 2 px tolerance.
- **9/9** live pipe-geometry checks passing with exact main paths, taps, valve positions, rail, manifold offsets, modes, and stage colors.
- The home page's static fallbacks are exercised directly: the logo strip starts at scroll position 0 with its fade mask and horizontal access, FAQ accordions open and close, mobile result dots start in sync with the first card and move the carousel, the mobile menu opens and closes, and the application submit guard does not send a request.
- Deliberate polish beyond the source: the home result rack bottom-aligns the three "See how we did it" actions in both the desktop grid and the mobile carousel, keeps platform icons on the first line when attribution copy wraps, and starts the mobile carousel with the first dot active. The case-study "read another" meta icons get the same first-line alignment in the 768-860 px band, and standalone back/CTA links have larger invisible hit areas without a painted change.
- Benchmark run: **13/13 selected routes verified** across a deterministic static multipage fixture (**3/3**), a deterministic SPA fixture (**3/3**), and the authorized external site (**7/7**, 21 viewport captures). **39/39 viewport captures** completed with zero warnings; the external route gate is **verified**. The overall benchmark status remains **review** because no authored interaction scenarios were run. Full results are in [docs/benchmark-report.md](docs/benchmark-report.md) and [docs/benchmark-results.json](docs/benchmark-results.json).

## Rebuild

The build uses the checked-in manifest by default:

```bash
npm run build
```

To build from another frozen capture:

```bash
MANIFEST=/path/to/evidence/routes.json OUT=/path/to/site node build.mjs
```

The capture must contain `evidence/routes.json` and the corresponding `source/<route>/rendered.html` files. The build fetches and localizes referenced assets from the manifest's authorized source origin.

## Scope and rights

This reconstruction was produced for authorized analysis and review. It is not affiliated with Revenue Media Lab and does not grant rights to the source's trademarks, copy, photography, or other protected assets. Do not deploy it as a production replacement.

Animations are intentionally out of scope: the static logo strip is presented at a clean start position, and animated source states are not claimed. The benchmark's SPA leg is the deterministic local fixture because no external client-rendered SPA was authorized. See the benchmark report for the full scope and review boundaries.
