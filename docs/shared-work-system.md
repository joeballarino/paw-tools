# Shared Work System

## Plain-English Architecture Summary

The shared Work system is owned by `tool-shell.js`.

Every tool hosts the same Work button markup in its header, but the tool page does not own what that button does. When the user clicks Work, `tool-shell.js` opens shared Works mode, mounts the real button into the Works header, hides the live tool surface, and renders the saved-work UI inside a shared root. When Works mode closes, `tool-shell.js` restores the tool exactly as it was.

Attached work is also shared shell state. A tool can read the currently attached work, react when it changes, and optionally save into that attached work through the shared save event. A tool must not create its own local Work mode or its own local attached-work state.

Presence and Transactions currently have lighter integration than Guide, Listing, and Connect, but they still follow the same shared contract because they host the same shared button and are initialized through the same shell.

## Ownership

`tool-shell.js` owns:

- Work button click wiring
- Works mode open and close behavior
- Work status text next to the button
- Works root creation and mounting
- Movement and restoration of the real Work button and status DOM nodes
- Shared attached/detached work session state
- Shared saved-work list rendering and shared save actions
- One-time cross-page handoff from `myworks.html`

Tool pages own:

- Hosting the shared Work button markup in the standard header
- Calling `window.PAWToolShell.init(...)`
- Tool-specific reactions to shared Work state after init
- Tool-specific fetch and restore logic when a saved work becomes active
- Tool-specific PATCH logic if the tool supports saving updates into an attached work

Tool pages do not own:

- Work button click behavior
- Works mode classes, root mounting, or DOM movement
- Shared attached-work state
- Shared save-event ordering
- Cross-page handoff parsing

## Open / Close Lifecycle

Open:

1. The user clicks `#pawMyStuffBtn`.
2. `window.__PAWWorks.init()` has already wired that button through `tool-shell.js`.
3. The shell calls `enterWorksMode()`.
4. The shell finds the live tool root, records scroll and focus, hides the tool surface, creates or reuses `#pawWorksModeRoot`, moves the real Work button and status into the Works header, renders the Works body, and loads the saved-works list.

Close:

Works mode closes only through shell-owned paths:

- clicking the shared Work button again
- pressing `Escape` while no `.modal.show` is open
- choosing `Use` on a saved work, which attaches the work and returns to the tool

On close, the shell restores the hidden tool surface, moves the real Work button and status back to their original home, restores scroll and focus, and removes Works mode classes.

## Mount / Render Behavior

The shared Works root is `#pawWorksModeRoot`. It is created lazily by `tool-shell.js` and mounted on `document.body`.

Works mode is a shell-managed mode swap, not a tool-local drawer and not a separate page.

When Works mode opens:

- the live tool surface is hidden
- the shared Works root becomes visible
- the real Work button is moved into the Works header
- the shared Work status element is moved with it
- disabled Reset and Tips buttons are rendered for visual continuity only
- Works content scrolls inside the Works root

When Works mode closes:

- the Works root is hidden
- the original tool surface is shown again
- the original button and status nodes are restored in their original order

The tool content is preserved in the DOM during this swap. It is hidden and shown again, not rebuilt by the Work system.

## Allowed Public APIs And Events

Safe tool-facing APIs:

- `window.PAWToolShell.init(config)`
- shell methods returned by `PAWToolShell.init(...)`
- `window.__PAWWorks.getActiveWork()`
- `window.__PAWWorks.detachWork()`

Shared events tools may consume:

- `paw:works:active_changed`
- `paw:works:save_current_output`

Shared behavior tools may rely on:

- active work is included in normal shell payloads when present
- a one-time launch handoff from `myworks.html` can attach a work during destination boot

Private or shell-only surfaces tools should not use:

- `window.__PAWWorks._open()`
- `window.__PAWWorks._close()`
- `#pawWorksModeRoot`
- `.paw-work-status`
- `html.paw-works-mode` and `body.paw-works-mode`
- `window.PAWToolShell._config`
- `window.PAWToolShell._toast`
- `window.PAWToolShell._getCurrentSaveSnapshot`

## Save Event Order Contract

The shared save flow has an order that tool pages must respect.

For a newly created work:

1. the shell creates the saved work
2. the shell attaches that new work as the active work
3. the shell emits `paw:works:save_current_output`
4. the current tool may PATCH its live payload into that active work

For an existing attached work:

1. the user chooses Save updates
2. the shell emits `paw:works:save_current_output`
3. the current tool may PATCH the attached work

Tool pages must not invent a competing save event or change the shared create then attach then save order.

## Cross-Page My Works Handoff Contract

`myworks.html` is the source page for the one-time launch handoff.

It writes a small payload to `sessionStorage` so that a destination tool can boot with the selected work already attached. `tool-shell.js` consumes that handoff once, clears it immediately, and exposes the result through normal shared active-work state.

Destination tools should react to active work after shell init. They should not read the handoff key directly or create a second handoff path.

## Forbidden Local Patterns

Do not do any of the following in a tool file:

- add a local click handler to `#pawMyStuffBtn`
- create a second Work drawer, panel, modal, or mode swap
- toggle `paw-works-mode` classes directly
- create or move `#pawWorksModeRoot`
- clone or locally move the Work button or `.paw-work-status`
- maintain a separate local attached-work source of truth
- parse the My Works session handoff key directly
- reorder shared save behavior
- treat `_open`, `_close`, `_config`, `_toast`, or `_getCurrentSaveSnapshot` as public APIs

## Regression Checklist For Future PRs

Before merging any tool PR that touches shared shell markup, tool headers, saved work behavior, or tool initialization, verify all of the following:

- The tool still hosts the standard shared Work button markup.
- `tool-shell.js` is still the only owner of Work button click behavior.
- The tool still calls `window.PAWToolShell.init(...)`.
- Clicking Work opens Works mode.
- Clicking Work again closes Works mode.
- Pressing `Escape` closes Works mode when no modal is open.
- The Work button and Work status move into Works mode and return to the tool in the same order.
- The live tool surface is hidden during Works mode and restored on close.
- Guide, Listing, Connect, Presence, and Transactions still all use the same shared Work contract.
- Any tool that listens for `paw:works:active_changed` still restores shared state correctly.
- Any tool that listens for `paw:works:save_current_output` still preserves the shared save order.
- No tool introduced local Work-mode logic, local status rendering logic, or direct manipulation of `#pawWorksModeRoot`.
