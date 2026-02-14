# CSS Inventory Report (no UI changes)

## 1) Global CSS/JS entry points
- **Shared stylesheet:** `paw-ui.css` is the global design system and shell styling layer (tokens, panel layout, topbar, controls, composer, modal, toasts, work-context button). All production tool pages link to `./paw-ui.css`.  
- **Shared runtime JS:** `tool-shell.js` is loaded from `https://paw-tools.pages.dev/tool-shell.js` on all tool pages in scope (`connect`, `guide`, `listing`, `presence`, `transactions`, `myworks`). It standardizes embed coercion, shell wiring, work context UI, reset/tips behavior, and status row injection.  
- **Non-shell pages:** `test.html` and `index.html` use **page-local `<style>` only** (no `paw-ui.css`, no `tool-shell.js`).

## 2) Per-page CSS summary
- **`connect.html`**
  - Loads `paw-ui.css` + one page-local `<style>` block.
  - Local styles are scoped to Connect segmented controls (`.connect-*`), mostly mirroring shared pill patterns with custom naming.
  - No inline `style="..."` attributes.
- **`guide.html`**
  - Loads `paw-ui.css`; no local `<style>` block.
  - Uses shared shell classes directly.
  - Small inline style usage (2 attributes).
- **`listing.html`**
  - Loads `paw-ui.css`; no local `<style>` block.
  - Heavy use of shared classes (`.controls-row`, `.field`, `.composer`, etc.) plus **many inline style attributes** for modal/detail fragments and generated markup.
- **`presence.html`**
  - Loads `paw-ui.css` + one page-local `<style>` block.
  - Local block defines Presence-only control rows (`.presence-*`) with duplicated field/pill/button idioms.
  - Limited inline style usage.
- **`transactions.html`**
  - Loads `paw-ui.css` + one page-local `<style>` block.
  - Local block defines Contracts-only segmented/file controls (`.stage-*`, `.type-*`, `.mini-btn`) using repeated shared visual primitives.
  - Limited inline style usage.
- **`myworks.html`**
  - Loads `paw-ui.css` + a large page-local `<style>` block.
  - Local styles intentionally re-theme header bands/tabs/editor surfaces for My Works.
  - Moderate inline style usage.
- **`test.html`**
  - Standalone preview harness; page-local CSS only.
- **`index.html`**
  - Standalone card-style landing page; page-local CSS only.

## 3) Token audit
- **`#05C3F9`**
  - Direct hex appears in `paw-ui.css` root token definition (`--accent:#05C3F9`).
  - Most runtime usage is via `rgba(5,195,249,...)` (many occurrences across shared + page-local styles).
- **`--paw-accent`**
  - **Not present** in audited files (0 occurrences).
- **Current accent tokening reality**
  - Existing token is `--accent`; used in shared controls but bypassed in many local page blocks that hardcode `rgba(5,195,249,...)`.
- **Legacy navy/shadow/border patterns**
  - `rgba(15,23,42,...)` is pervasive for text, borders, overlays, and neutral fills.
  - Border/shadow recipes repeat across files (e.g., `border:1px solid rgba(15,23,42,.08/.10/.12/.14)` + soft inset/ambient shadows).

## 4) Embed-mode audit
- **Signals in use**
  - URL parameter `embed=1` checked on pages and in `tool-shell.js`.
  - `html[data-embed="1"]` is the canonical CSS switch.
- **Activation flow**
  - Each tool page includes an early inline embed guard that sets `data-embed` when iframe or `embed=1`.
  - `tool-shell.js` also runs `coerceEmbedMode()` and sets `data-embed`, creating intentional redundancy.
- **Visual flattening behavior**
  - Shared embed rules flatten container chrome: transparent backgrounds, no outer panel border/radius/shadow.
  - Goal is to avoid “double container” inside Circle cards.

## 5) Toolbar/chips styling sources
- **“Work / Reset / Tips” row source of truth:** `paw-ui.css`
  - `.topbar-row0`, `.topbar-right`, `.paw-seg`, `.paw-seg__btn`, `.util-btn`, `.paw-works-btn`.
- **“Gray bands” / header banding**
  - Base top band: `.panel-topbar` radial glow in `paw-ui.css`.
  - Per-page overrides:
    - `myworks.html` adds stronger topbar/header gradients and tab region treatment.
    - `presence.html` / `transactions.html` / `connect.html` local blocks add section banding via local control wrappers.

## 6) Duplications + conflict risk
- **Segmented control duplication:** shared `.paw-seg` exists, but Connect/Presence/Transactions define parallel local segmented systems with near-identical border/radius/hover/active logic.
- **Field style duplication:** local blocks frequently restate shared field chrome (height, border radius, `rgba(15,23,42,...)` borders, inset highlight).
- **Embed guard duplication:** both page-level scripts and `tool-shell.js` set `data-embed`; low risk but increases maintenance surface.
- **Inline style override risk:** `listing.html` and `myworks.html` include notable inline styles; these have highest precedence and can silently diverge from token updates.
- **Override order sensitivity:** page-local `<style>` blocks load after `paw-ui.css`, so local definitions naturally win when selector specificity is equal.

## 7) Recommendation: minimal token-first alignment plan (“Embed Styling v1”)
1. **Alias token only (no visual refactor):** add `--paw-accent` as alias to current accent in shared CSS, keep `--accent` for compatibility.
2. **Token policy doc:** require new page-local styles to consume shared tokens (`--accent`, border/shadow tokens) instead of hardcoded RGBA values.
3. **Embed contract lock:** keep `data-embed` as single CSS gate; preserve current double-set behavior until all pages are verified stable.
4. **Topbar/chip contract note:** designate shared classes as canonical for `Work / Reset / Tips`; allow page-local variants only when scoped and documented.
5. **Hotspot cleanup queue (later, not now):** prioritize replacing hardcoded accent/navy/border values in `connect/presence/transactions/myworks` local blocks and inline fragments.

---
**Scope note:** This report is inventory-only. No CSS/JS/HTML behavior changes were made.
