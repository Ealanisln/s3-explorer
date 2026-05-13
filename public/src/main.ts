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
import { State, getPane } from './state.js';
import type { PaneId } from './state.js';
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
import { mountIcons } from './util/icons.js';
import { initModalTabs, initExpandButtons } from './util/modal-ux.js';
import {
  mountRightPane, initActivation, initDualToggle, paintRightPanePlaceholder,
} from './panes/init.js';

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
}
initTransferModalDismiss();

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
}

(async (): Promise<void> => {
  const ok = await authInit();
  if (ok) await loadConnectionsFlow();
})().catch((e: unknown) => {
  console.error('[main] boot failed:', e);
  toast('Error al iniciar la aplicación', 'error', 8000);
});

