# Changelog

Todos los cambios notables del proyecto se documentan acá. El formato sigue
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) y el proyecto se rige por
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
