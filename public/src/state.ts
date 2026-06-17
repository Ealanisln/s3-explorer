// Single mutable object holding the SPA's session state. Not a store framework
// — just a plain object, written from feature modules, read from render modules.
// The `subscribe` helper is a thin EventTarget wrapper for cross-cutting fields
// (active connection, active bucket) where multiple panels need to react.
//
// Pane model (introduced with the two-pane explorer):
//   - Fields that are tied to a specific viewport (active bucket, prefix,
//     listed objects, selection, etc.) live in a PaneState — there's one per
//     pane (left, right).
//   - Fields that span the whole app (the user's list of connections, the
//     per-conn bucket caches) stay flat at the top.
//   - The exported `State` is a Proxy that transparently forwards pane-field
//     reads/writes to `panes[activePane]`. This keeps the existing flat-shape
//     API for the single-pane code path while letting new drag-and-drop /
//     transfer code address either pane directly via `State.panes.left` /
//     `State.panes.right`.

import type {
  Connection, S3Object, SortField, SortDir, SearchMeta, SearchFolderInfo,
} from './types.js';

export type PaneId = 'left' | 'right';

export interface BucketRow { Name: string; CreationDate: string | null }

export interface PaneState {
  activeConnId: string | null;
  activeBucket: string | null;
  // Per-pane bucket cache. Filled when the user selects a connection for
  // this pane; the sidebar displays whichever pane is active. Pane-scoped
  // (not global) so the two panes can browse independent connections with
  // independent bucket lists — and so a bucket click can always reach the
  // connection that loaded the displayed list.
  buckets: BucketRow[];
  prefix: string;
  objects: S3Object[];
  prefixes: string[];
  // Subset of `prefixes` whose contents are all delete-marker tombstones
  // (only populated when showDeleted is true). Used by the grid to apply
  // the DELETED badge + strikethrough styling to those folder rows.
  deletedPrefixes: Set<string>;
  selected: Set<string>;
  versioning: 'Enabled' | 'Suspended' | 'Disabled';
  filterTerm: string;
  searchResults: S3Object[] | null;
  searchFolderHits: Map<string, SearchFolderInfo> | null;
  searchMeta: SearchMeta | null;
  showDeleted: boolean;
  sort: { field: SortField; dir: SortDir };
  listingTruncated?: boolean;
  listingPages?: number;
  // Per-pane prefix navigation history (back/forward stack). Scoped to the
  // CURRENT (connId, bucket); switching either resets the stack. Maxes out
  // at NAV_HISTORY_MAX entries; the oldest gets dropped if exceeded. The
  // navIndex points at the CURRENT entry — back goes to navIndex-1, forward
  // to navIndex+1. The stack is rewound (truncated) when the user navigates
  // to a new path while not at the end, matching browser semantics.
  navHistory: string[];
  navIndex: number;
}

// Synchronized navigation across panes. When enabled, navigating into a
// folder on one side computes a "delta" relative to that pane's ANCHOR
// (the prefix where sync was switched on) and applies the same delta to
// the other pane's anchor. Lets users browse two buckets with similar but
// non-identical roots in lock-step. Anchors re-set on bucket / connection
// switch (silently) or when the user re-toggles sync.
export interface SyncNavState {
  enabled: boolean;
  leftAnchor: string;
  rightAnchor: string;
}

// The flat shape that consumers see. The pane-fields are virtual — at runtime
// they're served by the Proxy below from `panes[activePane]`.
export interface AppState extends PaneState {
  connections: Connection[];
  panes: { left: PaneState; right: PaneState };
  activePane: PaneId;
  dualMode: boolean;
  syncNav: SyncNavState;
}

function newPane(): PaneState {
  return {
    activeConnId: null,
    activeBucket: null,
    buckets: [],
    prefix: '',
    objects: [],
    prefixes: [],
    deletedPrefixes: new Set<string>(),
    selected: new Set<string>(),
    versioning: 'Disabled',
    filterTerm: '',
    searchResults: null,
    searchFolderHits: null,
    searchMeta: null,
    showDeleted: false,
    sort: { field: 'name', dir: 'asc' },
    navHistory: [''],   // start with bucket-root prefix as the seed entry
    navIndex: 0,
  };
}

// Cap of per-pane navigation history. Generous but bounded — if the user
// digs 100 folders deep without ever going back, the oldest entry rolls off.
export const NAV_HISTORY_MAX = 100;

// The set of keys that should be redirected to the active pane. Anything not
// here is read/written directly on the raw object.
const PANE_KEYS = new Set<keyof PaneState>([
  'activeConnId', 'activeBucket', 'buckets', 'prefix', 'objects', 'prefixes', 'deletedPrefixes', 'selected',
  'versioning', 'filterTerm', 'searchResults', 'searchFolderHits', 'searchMeta',
  'showDeleted', 'sort', 'listingTruncated', 'listingPages',
  'navHistory', 'navIndex',
]);

interface RawState {
  connections: Connection[];
  panes: { left: PaneState; right: PaneState };
  activePane: PaneId;
  dualMode: boolean;
  syncNav: SyncNavState;
}

const raw: RawState = {
  connections: [],
  panes: { left: newPane(), right: newPane() },
  activePane: 'left',
  dualMode: false,
  syncNav: { enabled: false, leftAnchor: '', rightAnchor: '' },
};

export const State: AppState = new Proxy(raw, {
  get(target, prop: string | symbol): unknown {
    if (typeof prop === 'string' && PANE_KEYS.has(prop as keyof PaneState)) {
      return target.panes[target.activePane][prop as keyof PaneState];
    }
    return (target as unknown as Record<string | symbol, unknown>)[prop];
  },
  set(target, prop: string | symbol, value: unknown): boolean {
    if (typeof prop === 'string' && PANE_KEYS.has(prop as keyof PaneState)) {
      (target.panes[target.activePane] as unknown as Record<string, unknown>)[prop] = value;
      return true;
    }
    (target as unknown as Record<string | symbol, unknown>)[prop] = value;
    return true;
  },
}) as unknown as AppState;

// Tiny event bus for fields that have multiple readers. Use sparingly —
// direct read is fine for one-off lookups; subscribe is for staying in sync.
const bus = new EventTarget();

export function emit(key: string): void {
  bus.dispatchEvent(new CustomEvent(key));
}

export function subscribe(key: string, fn: () => void): () => void {
  const handler = (): void => fn();
  bus.addEventListener(key, handler);
  return () => bus.removeEventListener(key, handler);
}

export function activeConn(): Connection | undefined {
  return State.connections.find((c) => c.id === State.activeConnId);
}

// Pane-aware accessor. Defaults to active pane. Useful for the drag-and-drop
// path which needs to read both sides simultaneously.
export function getPane(id?: PaneId): PaneState {
  return raw.panes[id || raw.activePane];
}

// Returns the connection object for a specific pane (defaults to active).
export function paneConn(id?: PaneId): Connection | undefined {
  const pane = getPane(id);
  return State.connections.find((c) => c.id === pane.activeConnId);
}

// Run `fn` with `activePane` temporarily set to `id`, so that any code
// reading `State.activeBucket`, `State.prefix`, etc. resolves against the
// requested pane. Always restores the prior active pane on exit, even if
// `fn` throws. Used by render functions that need to paint a specific pane
// regardless of which one currently has focus.
export function withPane<T>(id: PaneId, fn: () => T): T {
  const prev = raw.activePane;
  raw.activePane = id;
  try { return fn(); } finally { raw.activePane = prev; }
}

export function setActivePane(id: PaneId): void {
  if (raw.activePane === id) return;
  raw.activePane = id;
  emit('activePane');
}
