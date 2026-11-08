# Benchmark report: static multipage, SPA, and large responsive

Date: 2026-11-08

## Summary

The standalone RML workflow was measured against three site classes:

1. A deterministic static multipage fixture with a separate source and clone server.
2. A deterministic client-rendered SPA fixture, including two routes discovered only through `history` changes.
3. The authorized external site `https://revenuemedialab.com`, a seven-route, pre-rendered responsive site used for both multipage and large-responsive coverage.

Final measured result:

| Leg | Source | Discovered | Captured | Verified | Route gate | Wall clock |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| Static multipage fixture | Two independent local servers | 18 | 3 routes, 9 viewports | **3/3** | **verified** | 52.7 s |
| SPA fixture | Two independent local servers | 18 | 3 routes, 9 viewports | **3/3** | **verified** | 49.0 s |
| Authorized large responsive | `https://revenuemedialab.com/` | 7 | 7 routes, 21 viewports | **7/7** | **verified** | 175.1 s |

Across all three legs: **39/39 viewport captures completed** with **0 partial**, **0 failed**, **0 warnings**, **0 pending images**, **0 broken images**, and **0 stabilization timeouts**. **13/13 selected routes verified**, with **0 failed** and **0 blocked**. The top-level status is **review** for every leg only because no authored interaction scenario suite was run (`scenarioGate: not-run`); the route gate itself is **verified**.

The external leg's 21 visual comparisons all passed: 20 were pixel-exact and one mobile screenshot had a `0.000070` change ratio (310 changed pixels). All 21 geometry comparisons passed. The previous lone review from an empty-text structural wrapper is closed: the matcher now records exact empty structural matches as measured, and a regression test covers it. The external site therefore moved from **6/7 verified, 1 review** to **7/7 verified, 0 review**.

## Authorization and scope

Only `https://revenuemedialab.com` was authorized for external capture. It was used for the authorized static multipage and large-responsive coverage; it is one origin, not two independent sites. No second external SPA was authorized.

The external inventory is:

- `/`
- `/case-studies/advisory-ceo`
- `/case-studies/ai-founder`
- `/case-studies/sales-academy-founder`
- `/case-studies/software-founder`
- `/privacy`
- `/terms`

The site's `robots.txt` and `sitemap.xml` return HTML 404 pages, so discovery used rendered anchors and client-side history. A seven-route clean result does not prove that every unlinked page on the source was found.

The client-rendered SPA leg is the repository's deterministic fixture. It contains `/app`, `/app/profile`, and `/app/settings`; the last two are discovered only through SPA history changes. It is not a production third-party SPA, and it does not exercise remote data, authentication, production hydration, or network variance.

No credentials, private pages, form submissions, or consequential actions were used.

## Method

- Browser: Playwright 1.61.1, Chromium, headless.
- Viewports: 1440×1000, 768×1000, 390×844.
- Discovery: bounded rendered crawl with robots, sitemap candidates, visible anchors, hidden/dropdown navigation, SPA history, pagination, redirects, soft-404 detection, and scope limits.
- Capture: source screenshots, full-page and viewport images, observations, stabilization, lazy-image settling, and breakpoint probing.
- Verification: direct loads, internal links, mobile navigation, browser history, visual comparison, title/heading/font checks, and section geometry/styles against a clone.
- The static and SPA fixtures use **two separate local servers** built from the same deterministic fixture. That is a controlled workflow-equivalence check, not an independent implementation.
- The external leg captures the live source and verifies the RML static clone built from `capture/`. It is a reconstruction comparison, not a live-source self-baseline.
- No authored interaction scenarios were run. `scenarioGate` is `not-run` for all three legs, which is why `overallStatus` remains `review` even when every route gate is verified.

Commands used from the repository root:

```bash
npm install
PLAYWRIGHT_BROWSERS_PATH="$PWD/.pw-browsers" npx playwright install chromium
npm run build
npm test
npm run audit
npm run benchmark
```

## Results by site class

### Authorized external static multipage and large responsive

| Phase | Result | Time |
| --- | --- | ---: |
| Discovery | 7 discovered, 7 selected, 0 failed, 0 excluded, 0 unresolved, 0 truncated | 7.1 s |
| Capture | 7/7 routes captured, 21/21 viewports, 0 partial, 0 failed, 0 warnings | 78.7 s |
| Verification | 7/7 verified, 0 review, 0 failed, 0 blocked | 89.2 s |

Route types were one `home`, four `nested`, and two `page`; there were **zero SPA-only routes**, confirming that same-URL Next.js hydration was not misclassified. All seven direct loads, internal-link checks, and history checks passed. Mobile navigation passed on the five routes that expose it; the two legal pages correctly reported `not-applicable`.

Verification details:

- Direct loads: **7/7 pass**.
- Internal links: **7/7 pass**, with no broken or source-origin-escaped links.
- History: **7/7 pass**.
- Mobile navigation: **5/5 applicable pass**.
- Visual: **21/21 pass**; 20 exact, one mobile ratio of `0.000070`.
- Geometry: **21/21 pass**; no review sections.

The external homepage's full-page heights were identical at every audited width, including 7,614 px at 1440, 8,435 px at 768, and 11,349 px at 390.

### Deterministic static multipage fixture

The fixture discovery produced 18 routes: 17 selected and one intentional HTTP 404, with one private-route exclusion and one redirect. The benchmark selected three static routes: `/`, `/about`, and `/services`.

- Capture: **3/3** routes, **9/9** viewports, zero warnings.
- Verification: **3/3** routes verified, zero failed or blocked.
- Route gate: **verified**.
- Wall clock: 52.7 s (discovery 6.9 s, capture 19.0 s, verification 26.7 s).

This leg exercises static multipage discovery, sitemap and rendered-link reconciliation, dropdown navigation, a desktop/mobile menu, and exact source/clone comparison independent of the external site.

### Deterministic client-rendered SPA fixture

The fixture contains two genuine SPA-history routes:

| Route | Discovery source | Type |
| --- | --- | --- |
| `/app` | rendered HTML | page |
| `/app/profile` | `spa-history` | spa |
| `/app/settings` | `spa-history` | spa |

- Capture: **3/3** routes, **9/9** viewports, zero warnings.
- Verification: **3/3** routes verified, including direct deep links, links, mobile navigation, history, visual, and geometry.
- Route gate: **verified**.
- Wall clock: 49.0 s (discovery 6.7 s, capture 17.8 s, verification 24.4 s).

The SPA routes remain classified as `spa` only when history is their only discovery source. The external site, which also hydrates and changes same-URL history state, remains correctly classified as static multipage with no false SPA labels.

## Gaps found and fixed

### 1. The build and audits depended on an external reconstruction tree

The moved project initially referenced the previous capture and toolkit locations. The build now defaults to `capture/evidence/routes.json`, the source manifest is recorded relative to the project, the audit starts the local server itself, and the benchmark writes only under this repository.

Result: `npm run build`, `npm test`, `npm run audit`, and `npm run benchmark` all run from `/Users/forex/RML` without reading the old tree. The committed build reports `sourceManifest: "capture/evidence/routes.json"`.

### 2. The pipe was frozen from three screenshots

The pipe was previously exact only at 1440, 768, and 390 px. It now reads the source anchors, computes the rounded path, taps, couplers, valves, rail, and manifold from the source geometry, and recalculates on resize and font load.

The live comparison covers **390, 500, 640, 768, 900, 1024, 1100, 1180, and 1440 px**:

| Width | Mode | Rail x | Manifold y | Offset | Valve Δ | Paths/taps | Colors | Formula |
| ---: | --- | ---: | ---: | ---: | ---: | --- | --- | --- |
| 390 | centred | 28 | 5061 | 36 | 0 | exact | exact | exact |
| 500 | centred | 28 | 4323 | 36 | 0 | exact | exact | exact |
| 640 | row | 36 | 4039 | 36 | 0 | exact | exact | exact |
| 768 | row | 64 | 3673 | 44 | 0 | exact | exact | exact |
| 900 | row | 64 | 3272 | 44 | 0 | exact | exact | exact |
| 1024 | row | 64 | 3035 | 44 | 0 | exact | exact | exact |
| 1100 | row | 64 | 3027 | 44 | 0 | exact | exact | exact |
| 1180 | row | 64 | 2993 | 44 | 0 | exact | exact | exact |
| 1440 | row | 124 | 3097 | 44 | 0 | exact | exact | exact |

The final responsive audit covered **11 widths × 7 routes = 77 checks**, with **77/77 pass**, **21/21 primary screenshots exact**, zero height deltas, zero horizontal overflow, zero broken images, and matching intended internal scrollers.

### 3. Static controls were inert and the logo strip could freeze mid-scroll

The source scripts were removed for the static build. The runtime now restores the FAQ accordions, mobile menu, mobile result dots, and application-form guard. The logo strip is paused at its clean start position, keeps its fade mask, and exposes horizontal scrolling instead of a clipped mid-animation frame.

The direct browser test verifies the computed `animation-name: none`, `overflow-x: auto`, a track wider than its container, `scrollLeft` starting at 0 and moving horizontally, the mask, FAQ open/close state, mobile menu open/close, result-dot carousel movement, and the non-sending form status.

### 4. Same-URL hydration was misclassified as SPA navigation

The history observer now ignores same-path, same-search, and hash-only changes. Only a real path/search change becomes a history observation, and a route is typed `spa` only when history is its only discovery source.

Result: the external site has zero SPA-only routes; the fixture still produces two genuine SPA routes.

### 5. Fluid widths created false breakpoint transitions

Breakpoint probing now hashes structural layout properties rather than fluid pixel dimensions, and records CSS media boundaries separately. The capture summary for the final run is **39/39 viewports with zero warnings and zero partial captures**.

### 6. Lazy images could remain pending at purported completion

Image settling forces lazy images eager, scrolls them into range, waits for decode/load/error, and reports unresolved images. The final benchmark evidence has **0 pending, 0 broken, and 0 stabilization timeouts** across all 39 viewport captures.

### 7. Verification read URLs before client-side navigation settled

History and mobile-navigation checks now poll for the expected local route with an 8-second bound after click, back, and forward. The final external verification has **7/7 history pass** and **5/5 applicable mobile-navigation pass**, with no fabricated destination when no different route exists.

### 8. An exact empty structural section forced a review

The section matcher previously required visible text to promote a match to measured. The homepage has one presentational wrapper with no visible text; it had exact geometry and all 50 computed-style comparisons matched, but it still forced a route review at every viewport.

The matcher now promotes an empty source/clone pair to `measured` only when both texts are empty, tags match, all rect deltas are within the control tolerance, and every compared style matches. It is recorded as `matchedBy: "structure"`, not as a text match. `tests/match.test.mjs` covers the exact match and confirms that a shifted or differently styled section remains review-only.

Result: the external leg is **7/7 verified, 0 review** instead of 6/7 plus one review.

### 9. Benchmark result reporting used the wrong capture shape

The standalone runner initially treated the capture API's viewport count as an array. It now records the API's numeric viewport count and warning count, producing the committed summary in `docs/benchmark-results.json`.

## Out of scope and limitations

- **Animation reproduction.** The static build does not recreate the source's animation timeline. The logo marquee is intentionally presented at a clean start state with horizontal access. Animated source states are not claimed.
- **No external SPA.** The SPA leg is a deterministic local fixture because no external client-rendered SPA was authorized. It does not cover production framework hydration, remote data, deep-link server behavior, authentication, or third-party scripts.
- **One external origin.** The authorized site supplied both multipage and large-responsive coverage. These are not independent external sites.
- **Seven routes is not an exhaustive large-site crawl.** Discovery is limited by rendered links, sitemap availability, depth, query, pagination, and time. The source's robots and sitemap endpoints return HTML 404s.
- **No authored interaction scenarios.** The scenario gate remains `not-run`; every route is verified, but the overall status is conservatively `review`.
- **Intermediate motion profiles.** Tablet/intermediate animation timing was not baselined. Geometry and the responsive audit cover the widths; motion fidelity is not claimed there.
- **Chromium only.** Firefox, WebKit, real devices, and human visual review were not used.
- **Static verification is not a production app claim.** The static clone intentionally removes the source application runtime; form submission, dynamic data, and client-side app behavior are not reproduced.
- **No deployment.** This report covers the local build and local clone server only.

## Evidence

Committed:

- `capture/evidence/routes.json` and `capture/source/**/rendered.html` — frozen build input.
- `build-report.json` — 7 pages, 393 assets, 9,697,279 asset bytes, 0 failures.
- `docs/benchmark-results.json` — compact measured summaries for all three legs.
- `tests/pipe-geometry.json`, `tests/*.test.mjs` — golden and regression tests.

Local, ignored:

- `.benchmark/static-multipage/` — fixture discovery, capture, and verification evidence.
- `.benchmark/spa/` — SPA discovery, capture, and verification evidence.
- `.benchmark/large-responsive/` — authorized-source discovery, capture, and verification evidence.
- `.audit/responsive/report.json` — 77-check responsive audit.
- `.audit/pipe-geometry/report.json` — nine-width live geometry comparison.

## Final check state

| Check | Result |
| --- | --- |
| Build | 7 pages, 393 assets, 9,697,279 bytes, 0 failures |
| Local tests | **3/3 pass** |
| Responsive audit | **77/77 pass**; 21/21 primary screenshots exact |
| Pipe geometry | **9/9 widths exact** |
| Benchmark route gate | **13/13 selected routes verified** |
| Benchmark captures | **39/39 viewports**, 0 warnings, 0 partial |
| Benchmark route failures/blockers | **0 / 0** |
| Scenario gate | **not-run** (overall status: review) |
