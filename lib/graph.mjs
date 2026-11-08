function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function groupNavigation(entries, predicate) {
  const groups = new Map();
  for (const entry of entries) {
    if (!predicate(entry)) continue;
    const existing = groups.get(entry.href);
    if (existing) {
      existing.pages += 1;
      existing.labels.add(entry.label || "");
      existing.regions.add(entry.region);
    } else {
      groups.set(entry.href, {
        href: entry.href,
        pages: 1,
        labels: new Set([entry.label || ""]),
        regions: new Set([entry.region]),
      });
    }
  }
  return [...groups.values()]
    .map((entry) => ({
      href: entry.href,
      pages: entry.pages,
      labels: [...entry.labels].filter(Boolean),
      regions: [...entry.regions],
    }))
    .sort((left, right) => right.pages - left.pages || left.href.localeCompare(right.href));
}

function pathParent(localRoute, byLocalRoute) {
  const basePath = localRoute.split("?")[0];
  if (basePath === "/") return null;
  const segments = basePath.split("/").filter(Boolean);
  for (let index = segments.length - 1; index >= 1; index -= 1) {
    const candidate = `/${segments.slice(0, index).join("/")}`;
    if (byLocalRoute.has(candidate)) return candidate;
  }
  return byLocalRoute.has("/") && localRoute !== "/" ? "/" : null;
}

function breadcrumbFor(localRoute, byLocalRoute) {
  if (localRoute === "/") return ["/"];
  const chain = [localRoute];
  let current = localRoute;
  const seen = new Set([localRoute]);
  while (true) {
    const parent = pathParent(current, byLocalRoute);
    if (!parent || seen.has(parent)) break;
    chain.unshift(parent);
    seen.add(parent);
    current = parent;
  }
  if (chain[0] !== "/" && byLocalRoute.has("/")) chain.unshift("/");
  return chain;
}

/**
 * Build one inspectable graph from the route manifest. Every edge comes from
 * observed navigation evidence; no destination is invented.
 */
export function buildSiteGraph(manifest) {
  const routes = manifest.routes || [];
  const byCanonical = new Map(routes.map((route) => [route.canonicalUrl, route]));
  const byLocalRoute = new Map(routes.map((route) => [route.localRoute, route]));
  const navigation = routes.flatMap((route) =>
    (route.navigation || []).map((entry) => ({ ...entry, from: route.localRoute })),
  );

  const edgeKeys = new Set();
  const edges = [];
  const unresolvedEdges = [];
  for (const route of routes) {
    for (const url of route.outboundLinks || []) {
      const target = byCanonical.get(url);
      const detail = navigation.find((entry) => entry.from === route.localRoute && entry.url === url) || {};
      const edge = {
        from: route.localRoute,
        to: target ? target.localRoute : url,
        region: detail.region || "body",
        label: detail.label || "",
        visible: detail.visible ?? null,
        inDropdown: Boolean(detail.inDropdown),
        resolved: Boolean(target),
      };
      const key = `${edge.from}|${edge.to}|${edge.region}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push(edge);
      if (!target) {
        unresolvedEdges.push({
          from: route.localRoute,
          to: url,
          reason:
            (manifest.excluded || []).find((entry) => entry.canonicalUrl === url)?.reason ||
            (manifest.unresolvedLinks || []).find((entry) => entry.url === url)?.reason ||
            "not-captured",
        });
      }
    }
  }

  const pagesWithHeader = new Set(routes.filter((route) => (route.navigation || []).some((entry) => ["header", "nav"].includes(entry.region))).map((route) => route.localRoute)).size;
  const pagesWithFooter = new Set(routes.filter((route) => (route.navigation || []).some((entry) => entry.region === "footer")).map((route) => route.localRoute)).size;
  const headerThreshold = Math.max(2, Math.ceil(pagesWithHeader * 0.6));
  const footerThreshold = Math.max(2, Math.ceil(pagesWithFooter * 0.6));

  const globalNavigation = groupNavigation(
    navigation,
    (entry) => ["header", "nav"].includes(entry.region) && !entry.inDropdown,
  ).filter((entry) => entry.pages >= headerThreshold || routes.length <= 2);
  const footerNavigation = groupNavigation(
    navigation,
    (entry) => entry.region === "footer",
  ).filter((entry) => entry.pages >= footerThreshold || routes.length <= 2);
  const dropdownNavigation = groupNavigation(
    navigation,
    (entry) => entry.inDropdown || entry.region === "dropdown",
  );
  const sidebarNavigation = groupNavigation(navigation, (entry) => entry.region === "sidebar");

  const orphans = routes
    .filter((route) => route.localRoute !== "/" && (route.inboundLinks || []).length === 0)
    .map((route) => route.localRoute);
  const eligible = new Set(routes.filter((route) => route.discoveryStatus === "discovered").map((route) => route.localRoute));
  const reachable = new Set();
  const queue = eligible.has("/") ? ["/"] : [];
  const adjacency = new Map();
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from).push(edge.to);
  }
  while (queue.length) {
    const current = queue.shift();
    if (reachable.has(current) || !eligible.has(current)) continue;
    reachable.add(current);
    for (const next of adjacency.get(current) || []) {
      if (!reachable.has(next)) queue.push(next);
    }
  }
  const unreachable = [...eligible].filter((route) => route !== "/" && !reachable.has(route)).sort();

  const breadcrumbs = {};
  for (const route of routes) breadcrumbs[route.localRoute] = breadcrumbFor(route.localRoute, byLocalRoute);

  return {
    generatedAt: manifest.site?.discoveredAt || new Date().toISOString(),
    sourceUrl: manifest.site?.sourceUrl || null,
    nodes: routes.map((route) => ({
      route: route.localRoute,
      canonicalUrl: route.canonicalUrl,
      title: route.title,
      routeType: route.routeType,
      depth: route.depth,
      discoveryStatus: route.discoveryStatus,
      implementationStatus: route.implementationStatus,
      verificationStatus: route.verificationStatus,
      inbound: (route.inboundLinks || []).length,
      outbound: (route.outboundLinks || []).length,
    })),
    edges,
    unresolvedEdges,
    globalNavigation,
    footerNavigation,
    dropdownNavigation,
    sidebarNavigation,
    orphans,
    unreachable,
    breadcrumbs,
    sharedLayout: {
      header: globalNavigation.map((entry) => entry.href),
      footer: footerNavigation.map((entry) => entry.href),
      dropdowns: dropdownNavigation.map((entry) => entry.href),
    },
    summary: {
      nodes: routes.length,
      edges: edges.length,
      unresolvedEdges: unresolvedEdges.length,
      orphans: orphans.length,
      unreachable: unreachable.length,
      globalNavigation: globalNavigation.length,
      dropdownNavigation: dropdownNavigation.length,
    },
  };
}
