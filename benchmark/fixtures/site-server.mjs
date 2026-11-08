import { createServer } from "node:http";

const CSS = `
:root{--ink:#111827;--brand:#4f46e5;--line:#e5e7eb}
*{box-sizing:border-box}
html,body{margin:0}
body{font-family:Arial,Helvetica,sans-serif;color:var(--ink);background:#f8fafc}
a{color:inherit}
.site-header{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:24px;padding:16px 32px;background:#fff;border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:8px;font-weight:700;text-decoration:none}
.desktop-nav{display:flex;align-items:center;gap:16px;margin-left:auto}
.dropdown-wrap{position:relative}
.dropdown{position:absolute;top:100%;left:0;min-width:180px;display:flex;flex-direction:column;gap:8px;padding:8px;background:#fff;border:1px solid var(--line)}
.mobile-toggle{display:none;margin-left:auto}
.mobile-menu{display:none;flex-direction:column;gap:12px;padding:16px 32px;background:#fff;border-bottom:1px solid var(--line)}
.mobile-menu:not([hidden]){display:flex}
main{max-width:1120px;margin:0 auto;padding:48px 32px}
.card{position:relative;overflow:hidden;margin-bottom:24px;padding:32px;border:1px solid #c7d2fe;border-radius:14px;background:linear-gradient(135deg,#fff,#eef2ff);box-shadow:0 14px 30px #312e8122}
.card:before{content:"";position:absolute;inset:-30%;background:radial-gradient(circle at 30% 20%,#a78bfa55,transparent 55%);pointer-events:none}
.card>*{position:relative}
h1{margin:0 0 16px;font-size:48px;line-height:52px;letter-spacing:-1px}
h2{font-size:28px;line-height:34px}
p{font-size:18px;line-height:28px}
.cta{position:relative;display:inline-flex;align-items:center;height:48px;padding:0 20px;border:1px solid #4338ca;border-radius:11px;background:var(--brand);color:#fff;font:600 15px/1 Arial;text-decoration:none}
.cta:hover{filter:brightness(1.08)}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:24px}
.tile{display:flex;align-items:flex-end;height:100px;padding:12px;border:1px solid var(--line);border-radius:8px;background:#fff;text-decoration:none}
footer{display:flex;gap:16px;padding:32px;border-top:1px solid var(--line);background:#fff}
@media(max-width:800px){.grid{grid-template-columns:1fr}h1{font-size:36px;line-height:40px}main{padding:32px 20px}}
@media(max-width:640px){.desktop-nav{display:none}.mobile-toggle{display:inline-block}}
`;

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#4f46e5"/><path d="M9 23V9h8a5 5 0 010 10h-4" fill="none" stroke="#fff" stroke-width="2"/></svg>`;

const SCRIPT = `
document.querySelectorAll('button[aria-controls]').forEach((button) => {
  button.addEventListener('click', () => {
    const target = document.getElementById(button.getAttribute('aria-controls'));
    if (!target || target.tagName === 'DIALOG') return;
    const open = button.getAttribute('aria-expanded') === 'true';
    button.setAttribute('aria-expanded', String(!open));
    target.hidden = open;
  });
});
const dialogButton = document.getElementById('open-dialog');
if (dialogButton) {
  dialogButton.addEventListener('click', () => document.getElementById('interact-dialog')?.showModal());
}
const closeDialog = document.getElementById('close-dialog');
if (closeDialog) {
  closeDialog.addEventListener('click', () => closeDialog.closest('dialog')?.close());
}
document.querySelectorAll('[role=tab]').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('[role=tab]').forEach((item) => item.setAttribute('aria-selected', String(item === tab)));
    document.querySelectorAll('[role=tabpanel]').forEach((panel) => { panel.hidden = panel.id !== tab.getAttribute('aria-controls'); });
  });
});
document.querySelectorAll('[data-nav]').forEach((button) => {
  button.addEventListener('click', () => {
    history.pushState({}, '', button.dataset.nav);
    const view = document.getElementById('spa-view');
    if (view) view.textContent = 'View: ' + location.pathname;
  });
});
`;

const DRIFT_CSS = `
h1{font-size:40px}.card{border-radius:2px}.cta{height:36px}
`;

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function layout({ title, content, options, extraScripts = "", minimal = false }) {
  if (minimal) {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${CSS}</style></head><body>
<main>${content}</main><script>${extraScripts}</script></body></html>`;
  }
  const sourceOrigin = options.escapeLinks && options.sourceOrigin ? options.sourceOrigin : "";
  const href = (path) => (sourceOrigin ? new URL(path, sourceOrigin).href : path);
  const drift = options.variant === "drift" ? `<style>${DRIFT_CSS}</style>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="Fixture site for RML workflow tests">
<style>${CSS}</style>${drift}
</head><body>
<header class="site-header" role="banner">
  <a class="brand" href="${href("/")}"><img src="/logo.svg" width="28" height="28" alt="Studio logo">Studio North</a>
  <nav class="desktop-nav" aria-label="Primary">
    <a href="${href("/about")}">About</a>
    <div class="dropdown-wrap">
      <button class="nav-button" id="services-toggle" aria-expanded="false" aria-controls="services-menu">Services</button>
      <div class="dropdown" id="services-menu" hidden>
        <a href="${href("/services")}">All services</a>
        <a href="${href("/services/web-design")}">Web design</a>
        <a href="${href("/services/automation")}">Automation</a>
      </div>
    </div>
    <a href="${href("/portfolio")}">Portfolio</a>
    <a href="${href("/blog")}">Journal</a>
    <a href="${href("/contact")}">Contact</a>
  </nav>
  <button class="mobile-toggle" id="mobile-toggle" aria-expanded="false" aria-controls="mobile-nav">Menu</button>
</header>
<div class="mobile-menu" id="mobile-nav" hidden>
  <a href="${href("/about")}">About</a>
  <a href="${href("/services")}">Services</a>
  <a href="${href("/services/web-design")}">Web design</a>
  <a href="${href("/private")}">Private preview</a>
</div>
<main>${content}</main>
<footer role="contentinfo">
  <a href="${href("/contact")}">Contact</a>
  <a href="${href("/privacy")}">Privacy</a>
  <a href="${href("/app")}">Console</a>
  <a href="${href("/redirect")}">Old link</a>
  <a href="${href("/missing")}">Broken link</a>
  <a href="${href("/async")}">Async demo</a>
</footer>
<script>${SCRIPT}${extraScripts}</script>
</body></html>`;
}

const card = (heading, copy, extra = "") => `<section class="card"><h2>${escapeHtml(heading)}</h2><p>${copy}</p>${extra}</section>`;

function home(renderHref) {
  return `<section class="card"><h1>Design that works</h1><p>We are an independent studio building clear, durable digital products.</p><a class="cta" href="${renderHref("/contact")}">Start a project</a></section>
${card("Selected work", "Three recent engagements across product, brand, and automation.", `<div class="grid"><a class="tile" href="${renderHref("/portfolio")}">Northwind</a><a class="tile" href="${renderHref("/portfolio")}">Acme</a><a class="tile" href="${renderHref("/portfolio")}">Fieldwork</a></div>`)}
${card("What we believe", "Small teams, measured decisions, and long-lived systems.")}`;
}

function notFound() {
  return `<section class="card"><h1>404 - Page not found</h1><p>The page you asked for does not exist.</p><a class="cta" href="/">Back home</a></section>`;
}

function renderRoute(pathname, searchParams, options, renderHref) {
  if (pathname.startsWith("/app")) {
    return {
      title: "Console",
      body: `<section class="card"><h1>Console</h1><p>A small client-rendered application surface.</p><div id="spa-view">View: ${escapeHtml(pathname)}</div>
        <button data-nav="/app/settings" aria-controls="spa-view" aria-expanded="false">Open settings</button>
        <button data-nav="/app/profile" aria-controls="spa-view" aria-expanded="false">Open profile</button></section>`,
      spa: true,
    };
  }
  switch (pathname) {
    case "/":
      return { title: "Studio North - Home", body: home(renderHref) };
    case "/about":
      return {
        title: "About - Studio North",
        body: `<section class="card"><h1>${options.variant === "drift" ? "About the studio (changed)" : "About the studio"}</h1><p>Founded in 2016, we work with teams who care about craft.</p></section>
        ${card("Our values", "Clarity, restraint, and evidence.")}`,
      };
    case "/services":
      return {
        title: "Services - Studio North",
        body: `<section class="card"><h1>Services</h1><p>Two focused practices.</p><div class="grid">
          <a class="tile" href="${renderHref("/services/web-design")}">Web design</a>
          <a class="tile" href="${renderHref("/services/automation")}">Automation</a></div></section>`,
      };
    case "/services/web-design":
      return { title: "Web design - Studio North", body: `<section class="card"><h1>Web design</h1><p>Design systems, marketing sites, and product interfaces.</p></section>${card("How we work", "Research, prototypes, and measured delivery.")}` };
    case "/services/automation":
      return { title: "Automation - Studio North", body: `<section class="card"><h1>Automation</h1><p>Internal tools and reliable workflows.</p></section>${card("How we work", "Small integrations with clear ownership.")}` };
    case "/portfolio":
      return {
        title: "Portfolio - Studio North",
        body: `<section class="card"><h1>Portfolio</h1><p>Selected engagements.</p><div class="grid"><a class="tile" href="${renderHref("/contact")}">Northwind</a><a class="tile" href="${renderHref("/contact")}">Acme</a><a class="tile" href="${renderHref("/contact")}">Fieldwork</a></div></section>`,
      };
    case "/contact":
      return {
        title: "Contact - Studio North",
        body: `<section class="card"><h1>Contact</h1><p>Tell us about the work.</p><form action="/contact" method="post"><label>Email <input name="email" type="email"></label><button class="cta" type="submit">Send</button></form></section>`,
      };
    case "/privacy":
      return { title: "Privacy - Studio North", body: `<section class="card"><h1>Privacy</h1><p>We keep only the data needed to reply.</p></section>` };
    case "/sitemap-only":
      return { title: "Sitemap only - Studio North", body: `<section class="card"><h1>Sitemap only page</h1><p>This page is not linked from the primary navigation.</p></section>` };
    case "/interact":
      return {
        title: "Interactions - Studio North",
        body: `<section class="card"><h1>Interactions</h1><p>Safe controls used by scenario tests.</p>
          <button id="reveal" aria-expanded="false" aria-controls="extra-panel">Show details</button>
          <div id="extra-panel" hidden><p>Hidden panel content.</p><a href="${renderHref("/privacy")}">Privacy link</a></div>
          <div role="tablist"><button role="tab" aria-selected="true" aria-controls="tab-a">Tab A</button><button role="tab" aria-selected="false" aria-controls="tab-b">Tab B</button></div>
          <div id="tab-a" role="tabpanel">Panel A</div><div id="tab-b" role="tabpanel" hidden>Panel B</div>
          <details><summary>Accordion</summary><p>Accordion content.</p></details>
          <button id="open-dialog" aria-controls="interact-dialog" aria-expanded="false">Open dialog</button>
          <dialog id="interact-dialog"><p>Dialog content</p><button id="close-dialog">Close</button></dialog>
          <form action="/contact" method="post"><input name="email" type="email"><button type="submit">Send</button></form></section>`,
      };
    case "/volatile":
      return { title: "Volatile - Studio North", body: `<section class="card"><h1>Volatile page</h1><p>Render ${Math.random().toString(36).slice(2)} at ${new Date().toISOString()}</p></section>` };
    case "/lazy":
      return {
        title: "Lazy media - Studio North",
        body: `<section class="card"><h1>Lazy media</h1><p>A below-fold image must settle before capture is complete.</p>
          <div style="height:2000px" aria-hidden="true"></div>
          <img loading="lazy" src="/slow-logo.svg" width="64" height="64" alt="Lazy test logo"></section>`,
      };
    case "/async":
      return {
        title: "Async history - Studio North",
        minimal: true,
        body: `<section class="card"><h1>Async history</h1><p>A delayed client-side route change exercises history verification.</p>
          <a data-async-link href="/async-target">Open async target</a></section>`,
        extraScripts: `document.querySelector('[data-async-link]').addEventListener('click', (event) => { event.preventDefault(); const href = event.currentTarget.getAttribute('href'); setTimeout(() => history.pushState({}, '', href), 300); });`,
      };
    case "/async-target":
      return {
        title: "Async target - Studio North",
        minimal: true,
        body: `<section class="card"><h1>Async target</h1><p>The delayed client-side destination.</p></section>`,
      };
    case "/private":
      return { title: "Private preview - Studio North", body: `<section class="card"><h1>Private preview</h1><p>Not part of the public route inventory.</p></section>` };
    case "/blog": {
      const page = Number(searchParams.get("page") || "1");
      const next = page < 3 ? `<a href="${renderHref(`/blog?page=${page + 1}`)}">Next page</a>` : "";
      return {
        title: `Journal - page ${page}`,
        body: `<section class="card"><h1>${page === 1 ? "Latest writing" : `Journal page ${page}`}</h1><p>Notes on design and automation.</p>${next}</section>${card("Archive", "Everything published so far.")}`,
      };
    }
    case "/loop": {
      const n = Number(searchParams.get("n") || "0");
      return { title: "Loop page", body: `<section class="card"><h1>Loop page</h1><a href="${renderHref(`/loop?n=${n + 1}`)}">Next</a></section>` };
    }
    default:
      return null;
  }
}

/**
 * Local multipage fixture used by discovery, capture, scenario, and site
 * verification tests. No network access leaves 127.0.0.1.
 */
export async function startSite(options = {}) {
  const state = {
    variant: options.variant || "source",
    omit: new Set(options.omit || []),
    escapeLinks: Boolean(options.escapeLinks),
    sourceOrigin: options.sourceOrigin || null,
    delayMs: options.delayMs || 0,
  };
  const hits = [];

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    const pathname = requestUrl.pathname;
    hits.push({ method: request.method, path: pathname, search: requestUrl.search, at: Date.now() });
    if (state.delayMs) await new Promise((done) => setTimeout(done, state.delayMs));
    response.setHeader("cache-control", "no-store");

    if (request.method === "POST") {
      response.statusCode = 204;
      response.end();
      return;
    }
    if (pathname === "/favicon.ico") {
      response.statusCode = 204;
      response.end();
      return;
    }
    if (pathname === "/logo.svg") {
      response.setHeader("content-type", "image/svg+xml");
      response.end(LOGO);
      return;
    }
    if (pathname === "/slow-logo.svg") {
      await new Promise((done) => setTimeout(done, 150));
      response.setHeader("content-type", "image/svg+xml");
      response.end(LOGO);
      return;
    }

    const origin = `http://${request.headers.host}`;
    if (pathname === "/robots.txt") {
      response.setHeader("content-type", "text/plain");
      response.end(`User-agent: *\nDisallow: /private\nSitemap: ${origin}/sitemap.xml\n`);
      return;
    }
    if (pathname === "/sitemap.xml") {
      response.setHeader("content-type", "application/xml");
      response.end(`<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${origin}/pages.xml</loc></sitemap>
  <sitemap><loc>${origin}/missing-sitemap.xml</loc></sitemap>
</sitemapindex>`);
      return;
    }
    if (pathname === "/pages.xml") {
      response.setHeader("content-type", "application/xml");
      response.end(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${origin}/</loc></url>
  <url><loc>${origin}/about/</loc></url>
  <url><loc>${origin}/about?utm_source=sitemap</loc></url>
  <url><loc>${origin}/services</loc></url>
  <url><loc>${origin}/portfolio</loc></url>
  <url><loc>${origin}/sitemap-only</loc></url>
  <url><loc>${origin}/private</loc></url>
</urlset>`);
      return;
    }
    if (pathname === "/redirect") {
      response.statusCode = 302;
      response.setHeader("location", "/about");
      response.end();
      return;
    }
    if (pathname === "/missing" || state.omit.has(pathname)) {
      response.statusCode = 404;
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(layout({ title: "Page not found", content: notFound(), options: state }));
      return;
    }

    const renderHref = (path) => (state.escapeLinks && state.sourceOrigin ? new URL(path, state.sourceOrigin).href : path);
    const page = renderRoute(pathname, requestUrl.searchParams, state, renderHref);
    if (!page) {
      response.statusCode = 404;
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(layout({ title: "Page not found", content: notFound(), options: state }));
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(layout({ title: page.title, content: page.body, options: state, minimal: Boolean(page.minimal), extraScripts: page.extraScripts || "" }));
  });

  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;

  return {
    server,
    origin,
    url: `${origin}/`,
    hits,
    get options() {
      return state;
    },
    setOptions(next = {}) {
      Object.assign(state, next);
      if (next.omit) state.omit = new Set(next.omit);
    },
    async close() {
      await new Promise((done) => server.close(done));
    },
  };
}

export { layout as fixtureLayout };
