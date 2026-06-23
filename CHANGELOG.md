# Changelog

Todos los cambios notables del proyecto se documentan acá. El formato sigue
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) y el proyecto se rige por
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-06-23

Migración interna a TypeScript + SQLite (desde el viejo `server.js`/`auth.js` +
`users.json`), más features del explorador y endurecimiento de seguridad.

### Added
- Explorador de dos paneles: navegación independiente con historial back/forward
  por panel (Alt+←/→), "abrir en segundo panel", y botón de cerrar (×) en
  **cualquiera** de los dos paneles (cerrar el izquierdo migra el contenido del
  derecho a la vista única).
- Navegación sincronizada estilo FileZilla (modelo anchor-delta) que funciona
  aunque los paneles estén en buckets / conexiones distintas.
- Subida con resolución de conflictos: modal Reemplazar / Renombrar (auto-sufijo
  estilo macOS/Windows) / Saltar, con tamaño entrante vs existente + preview del
  nombre renombrado. Funciona también con versionado ON.
- CRUD de carpetas: crear, renombrar, eliminar (delete-marker o purga) y
  restaurar, con conteo previo y barra de progreso.
- Búsqueda con alcance por prefijo y matcheo de nombres de carpeta (BFS).
- Colapso de la barra lateral a tira de iconos.
- `SECURITY.md`: política de divulgación, modelo de seguridad, checklist de
  hardening de deploy, mapa OWASP Top 10 y tradeoffs aceptados.
- Opt-in `S3_ALLOW_HOSTS` (allowlist de endpoints S3, la postura SSRF más fuerte).

### Changed
- **Backend reescrito en TypeScript** bajo `src/`, compilado con `tsc -b`.
  Persistencia migrada de `users.json` a **SQLite** (`app.db`) con migraciones
  versionadas. Suite de tests con **vitest** (unit + integration).
- Códigos de recuperación: 40 → **128 bits** (el verificador acepta ambos
  formatos para no romper los ya emitidos).
- Assets estáticos servidos con `Cache-Control: no-cache` (revalidación por
  ETag) para que los builds nuevos no queden cacheados.

### Security
- **SSRF:** el bloqueo de metadata ahora canonicaliza la IP y cubre todo el
  rango link-local `169.254.0.0/16`, cerrando bypasses por codificación
  decimal/octal/hex e IPv4-mapped-IPv6.
- **TOTP:** sin replay — un código usado no se puede reutilizar dentro de su
  ventana de ~30s (`last_totp_step`, migración 003).
- **Fail-closed** en producción si faltan `SESSION_SECRET` / `TOTP_ENCRYPTION_KEY`.
- Cleanup garantizado de archivos temporales de upload aunque `buildClient` falle.

### Fixed
- Marcado visual de carpetas eliminadas (badge DELETED) y opción de restaurar.
- Prevención de que una segunda conexión sobrescriba la primera.

## [1.1.0] - 2026-05-13

Rediseño visual completo del SPA al "Claude house style" — paleta cálida
off-white, terracota como acento, tipografía serif para títulos, line icons
SVG. Reemplazo total de emojis del UI. Mantiene 100% de compatibilidad con
los bindings TS existentes (`data-el`, IDs, clases estructurales).

### Added
- Self-hosted webfonts en `public/fonts/`: Inter (400/500/600/700), Source
  Serif 4 (400/500/600), JetBrains Mono (400/500/600). ~384KB total, sin
  dependencia de CDNs externos para respetar el CSP `default-src 'self'`.
- Sistema de iconos SVG line en `public/src/util/icons.ts` con ~50 paths
  (stroke 1.5px, `currentColor`). Hidratador `mountIcons(root)` que
  reemplaza `<i data-icon="lock"></i>` por `<svg>` inline al boot y
  después de cada render dinámico.
- Tabs en modal "Mi cuenta": Contraseña / Segundo factor / Recuperación
  (antes era una vista plana de dos secciones).
- Form "Nuevo usuario" expandible en modal de Usuarios — colapsado por
  default, click en "+ Nuevo usuario" lo despliega.
- Componentes nuevos del design system: `.ft-badge` (file-type badges para
  PDF/DOC/IMG/VID/ZIP/etc), `.pill` (status pills con variantes on/ok/warn),
  `.modal-tabs`, `.warn-block`, `.drag-ghost`, `.drop-overlay`,
  `.totp-grid`, `.recovery-codes`.
- Helper genérico `public/src/util/modal-ux.ts` con `initModalTabs()` y
  `initExpandButtons()` para futuros usos.

### Changed
- Reemplazo completo de `public/style.css` (+1132/-649). Tokens nuevos:
  superficies cálidas (`#FAF9F6` light, `#1A1916` dark), acento terracota
  `#C96442`, colores semánticos (`--danger`, `--success`, `--warn`),
  acentos por tipo de archivo, sombras de tres niveles, ring de focus.
- Default theme flip: ahora light por defecto, dark vía
  `<html data-theme="dark">`. `theme-init.js` no cambia su contrato.
- Tipografía: serif para H1/H2/brand/object-name, sans para todo el UI,
  mono para breadcrumbs/paths/version IDs/recovery codes.
- 14 emojis reemplazados por SVG line icons: 🔒 ⚙ 👥 ⏻ ☰ ✕ ⟳ ⫴ 🔄 📥 ↻
  ✅ ⚠ 🌓.
- Tabla de objetos usa FT-badges (`PDF`, `DOC`, `IMG`, `ZIP`, etc.) en
  lugar de emojis 📁/🖼/📦. La función `fileIcon()` en
  `public/src/util/format.ts` retorna `{cls, label}` con clases
  `.ft-badge.{pdf,doc,img,zip,def,folder}`.
- Modales reciben el shell visual nuevo: card 12px radius, animación
  `fade + translateY` de 200ms, header serif 20px, footer surface-2,
  backdrop con blur(2px). Variantes `.modal-lg` (680px) y `.modal-xl`
  (880px).
- Object Info panel ahora desliza desde la derecha como overlay absoluto
  (antes empujaba la tabla con un grid template). Mismo `data-el`, sin
  cambios en el TS.
- Auth overlay con radial gradient terracota sutil de fondo, card 420px
  centrada con `display: grid; place-items: center`.

### Removed
- Clases legacy del CSS: `.logo` (→ `.brand-mark`), `.icon-file` /
  `.icon-folder` / `.icon-img` / `.icon-doc` (→ `.ft-badge.*`),
  `.empty-state` (→ `.empty`), bloque vacío `.main, .pane {}`.
- Tokens CSS obsoletos: `--bg-2`, `--bg-3`, `--green`, `--red`, `--yellow`,
  `--primary`, `--primary-2`, `--accent-2`, `--shadow` (todos remapeados
  a sus equivalentes en el sistema nuevo).

### Fixed
- `bootstrap.ts` ahora setea `display:grid` (no `display:flex`) al abrir
  el auth overlay, para que el `place-items: center` del CSS centre la
  card correctamente.

### Notes
- La vista móvil queda diferida a una MR follow-up. El handoff del
  diseño incluye `mobile.jsx` (drawer 78%, top bar 52px, list-view rows
  56px, FAB, tab bar) que se portará en la Fase 2.
- Sin cambios en endpoints API, modelos de datos, autenticación, ni en
  el comportamiento de los flujos S3 (listado, búsqueda, transferencias,
  upload, versionado). Es un cambio puramente de presentación + algunas
  adiciones de UX en modales.
- Si tu sesión queda con el tema viejo cacheado, hacé hard-reload
  (Cmd+Shift+R) o limpiá el cache.
