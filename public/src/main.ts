// SPA entry point. Loaded by index.html via <script type="module">.
//
// Responsibilities:
//   1. Wire DOM listeners for every feature module (initFoo() calls).
//   2. Inject cross-module callbacks (the deps the modules need that come
//      from other modules — keeps each module testable in isolation).
//   3. Boot: authInit → if authed, loadConnections.

import { authInit, initAuthForms, configureAuthDeps } from './auth/bootstrap.js';
import { initAccountForms } from './auth/account.js';
import { initAdminUsers } from './auth/admin.js';
import {
  initPassphraseForm, openPassphraseModal,
} from './vault/ui.js';
import {
  getVault, readLegacyConnections, setPendingMigration, setVaultKey,
} from './vault/persistence.js';
import { State } from './state.js';
import { toast } from './util/toast.js';
import { $ } from './util/dom.js';
import {
  renderConnections, configureConnections,
} from './connections/list.js';
import { initConnModal, openConnModal } from './connections/modal.js';
import { initImport } from './connections/import.js';
import { configureBuckets } from './buckets/list.js';
import {
  loadObjects, renderGrid, initBatchBar, toggleEmpty,
} from './objects/grid.js';
import {
  initPreview, configurePreview,
} from './objects/preview.js';
import {
  initInfoPanel, configureInfoPanel,
} from './objects/info-panel.js';
import { initUpload, configureUpload } from './objects/upload.js';
import { initSearch, configureSearch } from './objects/search.js';
import {
  initSmallForms, initModalDismiss, initLockButton, configureLock,
} from './objects/forms.js';
import { initReindex, onBucketOpened as reindexOnBucketOpened } from './index/reindex.js';
import { initThemeToggle, applyTheme, loadTheme } from './util/theme.js';

// Theme init runs FIRST so the toggle icon shows the right preference
// glyph from the very first paint. The effective theme is already set on
// <html> by /theme-init.js (loaded synchronously in <head>); this call
// is the runtime counterpart that wires the toggle + system-pref listener.
applyTheme(loadTheme());

// ─── Dependency wiring ─────────────────────────────────────────────────────
//
// Each "configure*" call hands a module its cross-module callback so it doesn't
// have to import the consumer directly (which would risk cycles).

configureAuthDeps({ onAuthenticated: () => loadConnectionsFlow() });
configurePreview({ onObjectsChanged: () => loadObjects() });
configureInfoPanel({ onObjectsChanged: () => loadObjects() });
configureUpload({ onUploadComplete: () => loadObjects() });
configureSearch({ onRenderGrid: () => renderGrid(), onLoadObjects: () => loadObjects() });
configureConnections({ openEditModal: (c) => openConnModal(c) });
configureBuckets({ onBucketOpened: () => reindexOnBucketOpened() });
configureLock({
  onLock: () => {
    if (!confirm('Bloquear la bóveda? Tendrás que ingresar la contraseña de nuevo.')) return;
    setVaultKey(null);
    State.connections = [];
    State.activeConnId = null;
    renderConnections();
    toggleEmpty(true);
    $('empty').innerHTML = '<h2>Bóveda bloqueada</h2><p>Desbloquea para acceder a tus conexiones.</p><button class="btn btn-primary" id="btn-unlock-now">Desbloquear</button>';
    $('btn-unlock-now').onclick = (): void => openPassphraseModal({ mode: 'unlock' });
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
initInfoPanel();
initUpload();
initSearch();
initSmallForms();
initModalDismiss();
initLockButton();
initReindex();
initThemeToggle();

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
    toggleEmpty(true);
    $('empty').innerHTML = '<h2>Bóveda desbloqueada</h2><p>Selecciona una conexión en la barra lateral.</p>';
  } else {
    toggleEmpty(true);
    $('empty').innerHTML = '<h2>Bienvenido a S3 Explorer</h2><p>Crea una conexión para empezar a navegar tus archivos en cualquier almacenamiento compatible con S3 (AWS S3, MinIO, Wasabi, Backblaze B2, Cloudflare R2, etc.).</p><button class="btn btn-primary" id="btn-first-conn-empty">Agregar conexión</button>';
    const btn = document.getElementById('btn-first-conn-empty');
    if (btn) btn.onclick = (): void => openConnModal(null);
  }
}

initBatchBar();

(async (): Promise<void> => {
  const ok = await authInit();
  if (ok) await loadConnectionsFlow();
})().catch((e: unknown) => {
  console.error('[main] boot failed:', e);
  toast('Error al iniciar la aplicación', 'error', 8000);
});
