// SPA entry point. Loaded by index.html via <script type="module">.
//
// Responsibilities:
//   1. Wire DOM listeners for every feature module (initFoo() calls).
//   2. Inject cross-module callbacks (the deps the modules need that come
//      from other modules — keeps each module testable in isolation).
//   3. Boot: authInit → if authed, loadConnections.
//
// Two-pane: the right pane is cloned from the left at boot (panes/init.ts),
// then every pane-scoped initX() is called twice — once per paneId. The
// right pane stays `hidden` until the user toggles dual-mode on.

import { authInit, initAuthForms, configureAuthDeps } from './auth/bootstrap.js';
import { initAccountForms } from './auth/account.js';
import { initAdminUsers } from './auth/admin.js';
import {
  initPassphraseForm, openPassphraseModal,
} from './vault/ui.js';
import {
  getVault, readLegacyConnections, setPendingMigration, setVaultKey,
} from './vault/persistence.js';
import { State, getPane, subscribe } from './state.js';
import type { PaneId } from './state.js';
import {
  parseLocation, navigateTo, onRouteChange, setRouterSuppress, type Route,
} from './router/index.js';
import { selectConnection } from './connections/list.js';
import { openBucket } from './buckets/list.js';
import { toast } from './util/toast.js';
import { paneEl } from './util/dom.js';
import { confirmDialog } from './util/dialog.js';
import {
  renderConnections, configureConnections,
} from './connections/list.js';
import { initConnModal, openConnModal } from './connections/modal.js';
import { initImport } from './connections/import.js';
import { configureBuckets, setTreeRenderer } from './buckets/list.js';
import {
  loadObjects, renderGrid, initBatchBar, toggleEmpty, initDragDrop,
  initNavButtons, initNavShortcuts,
} from './objects/grid.js';
import { initTransferModalDismiss } from './panes/transfer.js';
import {
  initPreview, configurePreview,
} from './objects/preview.js';
import {
  initInfoPanel, configureInfoPanel,
} from './objects/info-panel.js';
import { initUpload, configureUpload } from './objects/upload.js';
import { initSearch, configureSearch } from './objects/search.js';
import {
  initGlobalForms, initPaneForms, initModalDismiss, initLockButton, configureLock,
} from './objects/forms.js';
import { initReindex, onBucketOpened as reindexOnBucketOpened } from './index/reindex.js';
import { initThemeToggle, applyTheme, loadTheme } from './util/theme.js';
import { initDrawer } from './util/drawer.js';
import { initResizers } from './util/resizers.js';
import { mountIcons } from './util/icons.js';
import { initModalTabs, initExpandButtons } from './util/modal-ux.js';
import {
  mountRightPane, initActivation, initDualToggle, paintRightPanePlaceholder,
} from './panes/init.js';
import { initSyncNavToggle, setSyncNavDeps } from './panes/synced-nav.js';

applyTheme(loadTheme());

// Hydrate <i data-icon="..."> → <svg> across the static HTML (auth overlay,
// sidebar, toolbar, info panel, modals). Must run BEFORE mountRightPane()
// so the clone inherits the already-resolved <svg> nodes.
mountIcons(document);

// ─── Right pane cloned BEFORE init*() runs so listener wiring covers both ──
mountRightPane();

const PANES: PaneId[] = ['left', 'right'];

// ─── Dependency wiring ─────────────────────────────────────────────────────

configureAuthDeps({ onAuthenticated: () => loadConnectionsFlow() });
configurePreview({ onObjectsChanged: () => loadObjects() });
configureInfoPanel({ onObjectsChanged: (paneId) => loadObjects(paneId) });
configureUpload({ onUploadComplete: (paneId) => loadObjects(paneId) });
configureSearch({ onRenderGrid: (paneId) => renderGrid(paneId), onLoadObjects: (paneId) => loadObjects(paneId) });
configureConnections({ openEditModal: (c) => openConnModal(c) });
configureBuckets({ onBucketOpened: (paneId) => reindexOnBucketOpened(paneId) });
setTreeRenderer(() => renderConnections());
setSyncNavDeps({ loadObjects: (paneId) => loadObjects(paneId) });
configureLock({
  onLock: async () => {
    const ok = await confirmDialog({
      title: 'Bloquear bóveda',
      message: 'Tus conexiones quedarán cifradas hasta que vuelvas a ingresar tu contraseña. ¿Continuar?',
      confirmLabel: 'Bloquear',
    });
    if (!ok) return;
    setVaultKey(null);
    State.connections = [];
    for (const p of PANES) {
      getPane(p).activeConnId = null;
      getPane(p).activeBucket = null;
      getPane(p).buckets = [];
    }
    renderConnections();
    toggleEmpty(true, 'left');
    toggleEmpty(true, 'right');
    paneEl('empty', 'left').innerHTML = '<h2>Bóveda bloqueada</h2><p>Desbloquea para acceder a tus conexiones.</p><button class="btn btn-primary" id="btn-unlock-now">Desbloquear</button>';
    const btn = document.getElementById('btn-unlock-now');
    if (btn) btn.onclick = (): void => openPassphraseModal({ mode: 'unlock' });
  },
});

// ─── Init listeners (DOM ready — module scripts already defer) ─────────────

initAuthForms();
initAccountForms();
initAdminUsers();
initPassphraseForm({ onUnlocked: () => onVaultUnlocked() });
initConnModal();
initImport();
initPreview();
initGlobalForms();
initModalDismiss();
initLockButton();
initThemeToggle();
initDrawer();
initResizers();
initActivation();
initDualToggle();
initModalTabs();
initExpandButtons();

// Pane-scoped wiring for both left and right.
for (const p of PANES) {
  initInfoPanel(p);
  initUpload(p);
  initSearch(p);
  initPaneForms(p);
  initReindex(p);
  initBatchBar(p);
  initDragDrop(p);
  initNavButtons(p);
}
// Alt+Left / Alt+Right history shortcuts. Bound globally to the document —
// fires for whichever pane has activePane focus.
initNavShortcuts();
initTransferModalDismiss();
// Synced-nav toggle has to run AFTER the right pane is cloned (so the
// data-el="btn-sync-nav" exists on both panes) and after the per-pane init
// loop (so paneEl() lookups work).
initSyncNavToggle();

// ─── Boot ───────────────────────────────────────────────────────────────────

async function loadConnectionsFlow(): Promise<void> {
  const vault = getVault();
  if (!vault) {
    const legacy = readLegacyConnections();
    if (legacy.length) setPendingMigration(legacy);
    State.connections = [];
    renderConnections();
    openPassphraseModal({ mode: 'create' });
    return;
  }
  openPassphraseModal({ mode: 'unlock' });
}

async function onVaultUnlocked(): Promise<void> {
  renderConnections();
  if (State.connections.length) {
    toggleEmpty(true, 'left');
    paneEl('empty', 'left').innerHTML = '<h2>Bóveda desbloqueada</h2><p>Selecciona una conexión en la barra lateral.</p>';
  } else {
    toggleEmpty(true, 'left');
    paneEl('empty', 'left').innerHTML = '<h2>Bienvenido a S3 Explorer</h2><p>Crea una conexión para empezar a navegar tus archivos en cualquier almacenamiento compatible con S3 (AWS S3, MinIO, Wasabi, Backblaze B2, Cloudflare R2, etc.).</p><button class="btn btn-primary" id="btn-first-conn-empty">Agregar conexión</button>';
    const btn = document.getElementById('btn-first-conn-empty');
    if (btn) btn.onclick = (): void => openConnModal(null);
  }
  paintRightPanePlaceholder();
  // Try to restore the location from the URL (e.g. user reloaded, or pasted
  // a shared link). Routing applies only to the active (left) pane.
  await tryRestoreFromUrl();
}

// Apply a parsed Route to the active pane, going through the normal
// selectConnection / openBucket / loadObjects paths. Each of those normally
// calls navigateTo() to update the URL, so we suppress that during apply
// (the URL is already where we want it) and emit a single replaceState at
// the end to make sure it's exact.
async function applyRoute(r: Route): Promise<void> {
  if (!r.connId) return;
  const conn = State.connections.find((c) => c.id === r.connId);
  if (!conn) {
    toast(`Conexión "${r.connId.slice(0, 8)}…" no encontrada en tu bóveda local.`, 'info', 6000);
    navigateTo({}, { replace: true });
    return;
  }
  setRouterSuppress(true);
  try {
    await selectConnection(conn.id, 'left', { autoExpand: true, skipPaint: !!r.bucket });
    if (r.bucket) {
      // Verify the bucket exists in the freshly loaded list (or in the manual
      // bucket list of the connection) — opening one that isn't accessible
      // would just toast an error in loadObjects, which is fine.
      await openBucket(r.bucket, 'left');
      if (r.prefix) {
        // Navigate into the saved prefix via a single loadObjects call.
        getPane('left').prefix = r.prefix;
        await loadObjects('left');
      }
    }
  } finally {
    setRouterSuppress(false);
  }
  // Replace the URL with the exact route so any normalization (trailing
  // slashes, etc.) is reflected. No new history entry.
  const pane = getPane('left');
  navigateTo({
    connId: pane.activeConnId || undefined,
    bucket: pane.activeBucket || undefined,
    prefix: pane.prefix,
  }, { replace: true });
}

async function tryRestoreFromUrl(): Promise<void> {
  const r = parseLocation();
  if (!r.connId) return;
  await applyRoute(r);
}

// Browser back/forward — popstate gives us a new URL to apply. Same path
// as restore-from-URL.
onRouteChange((r) => { void applyRoute(r); });

// When the user clicks the right pane, the URL should reflect IT. Use
// replaceState so we don't pile up history entries every time focus moves.
subscribe('activePane', () => {
  const pane = getPane();
  if (!pane.activeConnId) {
    navigateTo({}, { replace: true });
    return;
  }
  navigateTo({
    connId: pane.activeConnId,
    bucket: pane.activeBucket || undefined,
    prefix: pane.prefix,
  }, { replace: true });
});

(async (): Promise<void> => {
  const ok = await authInit();
  if (ok) await loadConnectionsFlow();
})().catch((e: unknown) => {
  console.error('[main] boot failed:', e);
  toast('Error al iniciar la aplicación', 'error', 8000);
});

