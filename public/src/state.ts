// Single mutable object holding the SPA's session state. Not a store framework
// — just a plain object, written from feature modules, read from render modules.
// The `subscribe` helper is a thin EventTarget wrapper for cross-cutting fields
// (active connection, active bucket) where multiple panels need to react.

import type {
  Connection, S3Object, SortField, SortDir, SearchMeta, SearchFolderInfo,
} from './types.js';

export interface AppState {
  connections: Connection[];
  activeConnId: string | null;
  buckets: { Name: string; CreationDate: string | null }[];
  activeBucket: string | null;
  prefix: string;
  objects: S3Object[];
  prefixes: string[];
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
}

export const State: AppState = {
  connections: [],
  activeConnId: null,
  buckets: [],
  activeBucket: null,
  prefix: '',
  objects: [],
  prefixes: [],
  selected: new Set<string>(),
  versioning: 'Disabled',
  filterTerm: '',
  searchResults: null,
  searchFolderHits: null,
  searchMeta: null,
  showDeleted: false,
  sort: { field: 'name', dir: 'asc' },
};

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
