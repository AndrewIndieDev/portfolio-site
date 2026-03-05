# AGENTS.md - portfolio-site

## Scope
These instructions apply to the entire `portfolio-site` repository.

## Professional Standard
- You are a professional web developer.
- Default to size-optimized output for web assets when requested.
- Everything you write does not need to be human-readable when the goal is compactness/performance.

## Project Snapshot
- Frontend is a static single-page site composed of `index.html`, `styles.css`, and `app.js`.
- `index.html` contains structure and script includes only.
- Frontend behavior is implemented in `app.js` (achievements, UI controls, boss widget, XP system).
- Backend logic lives in `functions/index.js` (Firebase Functions v2 callable endpoints + scheduler).
- Security model relies on Firestore rules in `firestore.rules` with writes handled by Cloud Functions.

## Tooling Expectations
- Use `rg` / `rg --files` for search and discovery.
- Prefer focused edits (`apply_patch` or equivalent small diffs), not broad rewrites.
- Avoid reading or editing `node_modules` unless explicitly required.
- Do not use Python for simple file search/edit tasks when shell tools are sufficient.

## File Ownership
- `index.html`: document structure, metadata, and script/style links.
- `styles.css`: all styling, animation, responsive layout behavior.
- `app.js`: all client-side interactivity and state logic.
- `functions/index.js`: authoritative gameplay/economy/server logic.
- `firestore.rules`: client read/write permissions.
- `firebase.json` / `.firebaserc`: Firebase project/runtime config.

## Guardrails
- Keep the existing static architecture (no framework migration unless requested).
- Keep app logic in `app.js`; avoid adding new inline scripts in `index.html`.
- Preserve core UX patterns unless asked to change them:
  - horizontal section flow
  - controller/minimap interaction model
  - achievements + XP + boss widget loops
- Maintain mobile behavior when changing layout (existing breakpoints around `900px` and `600px`).
- For backend/economy changes, keep server authority:
  - never trust client-submitted totals for XP/damage
  - validate auth/input on callable functions
  - use transactions for shared state updates
- Keep Firebase Functions region as `australia-southeast1` unless migration is requested.
- Do not change lockfiles or dependencies unless the task explicitly needs it.

## Validation Workflow
- Frontend-only changes:
  - smoke test in browser at desktop + mobile widths
  - verify no obvious console errors from edited paths
  - run `node --check app.js` after JavaScript changes when possible
- Functions changes:
  - run from `functions/`: `npm run serve` (or `npm run shell`) when possible
  - quick syntax check: `node --check functions/index.js`
- If validation cannot be run, state that clearly in the final handoff.

## Delivery Expectations
- Keep changes minimal, targeted, and consistent with existing code style.
- Prefer root-cause fixes over temporary patches.
- Call out security-sensitive, schema-sensitive, or behavior-changing updates explicitly.
