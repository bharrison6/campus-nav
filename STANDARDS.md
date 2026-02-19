# Murray-State-Campus-Navigation Standards

## Scope
- Campus navigation application for Murray State University.
- **Platform:** Google Apps Script web app (served via HtmlService).
- **Backend:** Google Apps Script with Google Sheets data store.
- **Deploy toolchain:** clasp v3 — see `C:\GitHub\workflows\google-apps-script-clasp.md` for full guide.

## Required Startup Checks
- Read `C:\GitHub\CLAUDE.md` (or respective agent protocol) before work.
- Read `.agent-log/changelog.md` and `.agent-log/handoffs.md` before changes.
- Log completed work in `.agent-log/changelog.md`.

## Technical Rules
- Follow the GAS + clasp workflow in `C:\GitHub\workflows\google-apps-script-clasp.md`.
- Use the 3-step deploy sequence: `push → create-version → create-deployment`.
- (Additional rules to be defined during project planning.)

## Code Quality
- Prefer small functions with single responsibility.
- Keep code readable and well-structured.
- Avoid hidden global side effects.

## Project Layout
- `scripts/apps-script/` — GAS source files, clasp config, deploy script.
- `.agent-log/` holds multi-agent coordination logs.
- (Additional layout to be defined during project planning.)
