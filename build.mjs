import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = process.env.MANIFEST || join(HERE, "capture/evidence/routes.json");
const OUT = process.env.OUT || join(HERE, "site");
const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
const sourceRoot = dirname(dirname(MANIFEST_PATH));
const sourceOrigin = manifest.site.origin;
const assetCache = new Map();
const assets = [];
const failures = [];
const startedAt = Date.now();

const MOBILE_MENU = `
<div id="mobile-nav" hidden>
  <a href="/">Revenue Media Lab home</a>
  <a href="/case-studies/ai-founder">AI founder case study</a>
  <a href="/case-studies/software-founder">Software founder case study</a>
  <a href="/case-studies/advisory-ceo">Advisory CEO case study</a>
  <a href="/case-studies/sales-academy-founder">Sales academy case study</a>
  <a href="/privacy">Privacy</a>
  <a href="/terms">Terms</a>
</div>`;

const SHELL_CSS = `
#mobile-nav[hidden] { display: none !important; }
#mobile-nav:not([hidden]) {
  position: fixed;
  z-index: 100;
  top: 84px;
  right: 16px;
  left: 16px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: calc(100vh - 104px);
  overflow: auto;
  padding: 12px;
  border: 2px solid var(--ink, #12181a);
  border-radius: 24px;
  background: var(--glass, #f4f8f6);
  box-shadow: 0 8px 0 var(--ink, #12181a);
}
#mobile-nav a {
  padding: 12px 14px;
  border-radius: 14px;
  color: var(--ink, #12181a);
  font-size: 16px;
  font-weight: 700;
  text-decoration: none;
}
#mobile-nav a:hover, #mobile-nav a:focus-visible { background: var(--glass-tint, #e7efea); }
/* Result rack: the cards stretch to the tallest card, so let the copy stack
   take the remaining height and anchor each action to the bottom. This keeps
   the "See how we did it" links on one line across the desktop grid and the
   mobile snap carousel. */
#results .rack-col > div:last-child { flex: 1 1 auto; }
#results .rack-col > div:last-child > a:last-child { margin-top: auto; }
/* Keep the platform icon on the first line when the handle wraps instead of
   centering it across two lines. */
#results .rack-col > div:last-child > span.flex { align-items: flex-start; margin-bottom: 4px; }
#results .rack-col > div:last-child > span.flex > img { margin-top: 3.75px; }
/* The case-study "read another" strip is three columns from 768px; in that
   narrow band the account label can wrap. Keep its platform icon on the first
   line there without touching the single-line rows at wider widths. */
@media (min-width: 768px) and (max-width: 860px) {
  [aria-labelledby="more-results"] a > span.flex.items-center { align-items: flex-start; }
  [aria-labelledby="more-results"] a > span.flex.items-center > img { margin-top: -2px; }
}
/* Expand the hit area of standalone links that sit below the 44px target,
   without moving them or changing their painted size. */
main > header > a[href="/#reports"],
main a.eyebrow[href="/"],
#reports article.case-card > a[href^="/case-studies/"] { position: relative; }
main > header > a[href="/#reports"]::after,
main a.eyebrow[href="/"]::after { content: ""; position: absolute; inset: -15px 0; }
#reports article.case-card > a[href^="/case-studies/"]::after { content: ""; position: absolute; inset: -11px 0; }
`;

function hash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function decodeEntities(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&#38;", "&")
    .replaceAll("&#x26;", "&");
}

function isAsset(raw) {
  if (!raw || raw.startsWith("#") || raw.startsWith("data:") || raw.startsWith("mailto:") || raw.startsWith("tel:")) return false;
  let url;
  try {
    url = new URL(decodeEntities(raw), sourceOrigin);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(url.protocol)) return false;
  if (url.origin === sourceOrigin && (url.pathname === "/" || url.pathname === "")) return false;
  if (url.pathname.startsWith("/_next/image")) return true;
  if (url.pathname.startsWith("/_next/static/")) return true;
  if (url.pathname.startsWith("/assets/")) return true;
  if (extname(url.pathname)) return true;
  return /^\/(brand|logos|testimonials)\//.test(url.pathname);
}

function extensionFor(contentType, pathname) {
  const type = String(contentType || "").split(";")[0].trim().toLowerCase();
  const byType = {
    "text/css": ".css",
    "font/woff2": ".woff2",
    "font/woff": ".woff",
    "font/ttf": ".ttf",
    "image/svg+xml": ".svg",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/avif": ".avif",
    "image/gif": ".gif",
    "application/javascript": ".js",
    "text/javascript": ".js",
  };
  const byPath = extname(new URL(pathname || "https://local/", "https://local/").pathname);
  return byType[type] || byPath || ".bin";
}

async function fetchAsset(raw) {
  const decoded = decodeEntities(raw);
  const absolute = new URL(decoded, sourceOrigin);
  if (assetCache.has(absolute.href)) return assetCache.get(absolute.href);
  const response = await fetch(absolute, {
    headers: {
      "user-agent": "RMLBenchmark/1.0",
      accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,text/css,font/woff2,*/*;q=0.8",
      referer: sourceOrigin + "/",
    },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${absolute.href}`);
  const body = Buffer.from(await response.arrayBuffer());
  const ext = extensionFor(response.headers.get("content-type"), absolute.pathname);
  const file = `assets/media/${hash(absolute.href)}${ext}`;
  await mkdir(join(OUT, "assets/media"), { recursive: true });
  await writeFile(join(OUT, file), body);
  const local = `/${file}`;
  assetCache.set(absolute.href, local);
  assets.push({ source: absolute.href, local, bytes: body.length, contentType: response.headers.get("content-type") });
  return local;
}

async function processCss(raw) {
  const decoded = decodeEntities(raw);
  const absolute = new URL(decoded, sourceOrigin);
  if (assetCache.has(absolute.href)) return assetCache.get(absolute.href);
  const response = await fetch(absolute, {
    headers: { "user-agent": "RMLBenchmark/1.0", accept: "text/css,*/*;q=0.8", referer: sourceOrigin + "/" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${absolute.href}`);
  let css = await response.text();
  const urls = [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)];
  for (const [full, , value] of urls) {
    if (value.startsWith("data:")) continue;
    const local = await fetchAsset(new URL(value, absolute).href);
    css = css.split(full).join(`url("${local}")`);
  }
  const file = `assets/css/${hash(absolute.href)}.css`;
  await mkdir(join(OUT, "assets/css"), { recursive: true });
  const body = Buffer.from(css);
  await writeFile(join(OUT, file), body);
  const local = `/${file}`;
  assetCache.set(absolute.href, local);
  assets.push({ source: absolute.href, local, bytes: body.length, contentType: "text/css" });
  return local;
}

function collectAssetUrls(html) {
  const found = new Set();
  for (const match of html.matchAll(/\b(?:src|href|poster)="([^"]+)"/g)) {
    if (isAsset(match[1])) found.add(match[1]);
  }
  for (const match of html.matchAll(/\bsrcset="([^"]+)"/g)) {
    for (const part of match[1].split(",")) {
      const raw = part.trim().split(/\s+/)[0];
      if (isAsset(raw)) found.add(raw);
    }
  }
  for (const match of html.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
    if (isAsset(match[2])) found.add(match[2]);
  }
  return [...found];
}

function rewriteUrl(html, raw, local) {
  const decoded = decodeEntities(raw);
  return html.split(raw).join(local).split(decoded).join(local);
}

async function buildRoute(route) {
  const evidenceDir = join(sourceRoot, route.evidenceDir || route.evidenceFile?.replace(/^evidence\/routes\//, "source/").replace(/\.json$/, ""));
  const htmlPath = join(evidenceDir, "rendered.html");
  let html = await readFile(htmlPath, "utf8");

  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  html = html.replace(/<link\b[^>]*\bas=["']script["'][^>]*>/gi, "");
  html = html.replaceAll(sourceOrigin, "");

  const urls = collectAssetUrls(html);
  for (const raw of urls) {
    try {
      const isCss = /\.css(?:[?#]|$)/i.test(decodeEntities(raw));
      const local = isCss ? await processCss(raw) : await fetchAsset(raw);
      html = rewriteUrl(html, raw, local);
    } catch (error) {
      failures.push({ route: route.localRoute, url: raw, error: error.message });
    }
  }

  html = html.replace(/\bloading="lazy"/gi, 'loading="eager"');
  html = html.replace("</head>", `<style>${SHELL_CSS}</style></head>`);
  let shell = MOBILE_MENU;
  if (route.localRoute === "/") {
    html = html.replace(
      '<svg aria-hidden="true" class="pointer-events-none absolute left-0 top-0 z-0 overflow-visible"',
      '<svg id="rml-pipe" aria-hidden="true" class="pointer-events-none absolute left-0 top-0 z-0 overflow-visible"',
    );
  }
  shell += '<script type="module" src="/reconstruction.js"></script>';
  html = html.replace("</body>", `${shell}</body>`);

  const relative = route.localRoute === "/" ? "index.html" : `${route.localRoute.replace(/^\//, "")}/index.html`;
  const target = join(OUT, relative);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, html);
  return { route: route.localRoute, file: relative, bytes: Buffer.byteLength(html), assets: urls.length };
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
for (const file of ["runtime.js", "motion.js", "easing.js", "pipe-render.js", "pipe-geometry.js"]) {
  await writeFile(join(OUT, file), await readFile(join(HERE, file)));
}
await writeFile(join(OUT, "reconstruction.js"), await readFile(join(HERE, "runtime.js")));
await writeFile(join(OUT, "robots.txt"), "User-agent: *\nDisallow:\n");
await writeFile(join(OUT, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${manifest.routes.map((route) => `<url><loc>${route.localRoute}</loc></url>`).join("")}</urlset>`);

const pages = [];
for (const route of manifest.routes) {
  if (route.captureStatus !== "captured") continue;
  const page = await buildRoute(route);
  pages.push(page);
  console.log(`built ${route.localRoute} -> ${page.file}`);
}

const report = {
  kind: "rml-reconstruction",
  sourceManifest: MANIFEST_PATH.startsWith(HERE) ? relative(HERE, MANIFEST_PATH) : MANIFEST_PATH,
  sourceOrigin,
  generatedAt: new Date().toISOString(),
  durationMs: Date.now() - startedAt,
  pages,
  assets: assets.length,
  assetBytes: assets.reduce((sum, asset) => sum + asset.bytes, 0),
  failures,
};
await writeFile(join(HERE, "build-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ pages: pages.length, assets: report.assets, assetBytes: report.assetBytes, failures: failures.length, output: OUT }, null, 2));
if (failures.length) process.exitCode = 1;
