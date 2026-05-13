// Hash-based URL routing. Reflects the active pane's location
// (connection / bucket / prefix) in `window.location.hash` so:
//   - The browser's back/forward arrows navigate inside the SPA.
//   - A URL is shareable between tabs of the same s3-explorer install
//     (the recipient must have the same connection in their local vault).
//   - Reloading the tab restores the last folder, not the bucket root.
//
// Why hash, not HTML5 history routing: server.ts only serves index.html for
// `/` and static files. HTML5 routes (e.g. `/c/foo/b/bar/baz/`) would 404 on
// reload unless server.ts grew a SPA fallback. Hash sidesteps that entirely.
//
// Format:
//   #/c/<connId>/b/<bucket>/<encoded-prefix>
//   #/c/<connId>/b/<bucket>           (bucket root)
//   #/c/<connId>                      (no bucket yet)
//   ''                                (no connection)
//
// Credentials never appear in the URL. `connId` is the local vault id (UUID),
// not the access key.

export interface Route {
  connId?: string;
  bucket?: string;
  /** Without leading slash. Includes trailing slash for folders. */
  prefix?: string;
}

const HASH_RE = /^#\/c\/([^/]+)(?:\/b\/([^/]+)(?:\/(.*))?)?$/;

// Encode the prefix segment-by-segment so `/` is preserved literally and
// every other special char is percent-encoded. Trailing slash is kept.
function encodePrefix(prefix: string): string {
  if (!prefix) return '';
  const trailing = prefix.endsWith('/');
  return prefix
    .replace(/\/$/, '')
    .split('/')
    .map(encodeURIComponent)
    .join('/') + (trailing ? '/' : '');
}

function decodePrefix(s: string): string {
  if (!s) return '';
  return s.split('/').map((p) => {
    try { return decodeURIComponent(p); } catch { return p; }
  }).join('/');
}

export function parseLocation(): Route {
  const h = window.location.hash || '';
  const m = HASH_RE.exec(h);
  if (!m) return {};
  return {
    connId: m[1] ? decodeURIComponent(m[1]) : undefined,
    bucket: m[2] ? decodeURIComponent(m[2]) : undefined,
    prefix: m[3] !== undefined ? decodePrefix(m[3]) : undefined,
  };
}

export function buildHash(route: Route): string {
  if (!route.connId) return '';
  let h = `#/c/${encodeURIComponent(route.connId)}`;
  if (!route.bucket) return h;
  h += `/b/${encodeURIComponent(route.bucket)}`;
  // Always include the prefix slash even when empty, so `bucket/` URLs are
  // visually consistent with `bucket/foo/`.
  h += '/';
  if (route.prefix) h += encodePrefix(route.prefix);
  return h;
}

// Internal flag: when WE programmatically change the hash (pushState /
// replaceState), we also fire a hashchange-like notification, but we want to
// skip the popstate-driven re-application that would cause a loop.
let internalNavigation = false;

// Public flag: when set, callers of navigateTo() are silently no-op'd. Used
// during boot-time restore and popstate handling — the SPA mutates pane state
// to match the URL, and we don't want those mutations to spawn fresh URL
// updates that overwrite the URL we just landed on.
let suppress = false;
export function setRouterSuppress(v: boolean): void { suppress = v; }
export function isRouterSuppressed(): boolean { return suppress; }

export function navigateTo(route: Route, opts: { replace?: boolean } = {}): void {
  if (suppress) return;
  const next = buildHash(route);
  const current = window.location.hash;
  // No-op when the URL already matches — avoids spamming history entries
  // when the user clicks the current breadcrumb / re-selects the same bucket.
  if (next === current) return;
  internalNavigation = true;
  try {
    if (opts.replace) window.history.replaceState({}, '', next || '#');
    else window.history.pushState({}, '', next || '#');
  } finally {
    // Microtask delay so any synchronous popstate fired (unlikely, but
    // defensive) sees the flag set.
    queueMicrotask(() => { internalNavigation = false; });
  }
}

type RouteListener = (r: Route) => void;
const listeners = new Set<RouteListener>();

export function onRouteChange(fn: RouteListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

window.addEventListener('popstate', () => {
  if (internalNavigation) return;
  const r = parseLocation();
  listeners.forEach((fn) => fn(r));
});

// hashchange covers the case where the user pastes a different hash into the
// address bar manually — popstate doesn't always fire for that in older
// engines, hashchange always does.
window.addEventListener('hashchange', () => {
  if (internalNavigation) return;
  const r = parseLocation();
  listeners.forEach((fn) => fn(r));
});
