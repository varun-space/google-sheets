# sheets-work — MeDa Video Ops Dashboard

A small Cloudflare Worker + plain HTML app for the MeDa video editing team. It reads and writes the
**copy** of the Video Editing Tracker Google Sheet through the Sheets REST API. `CLAUDE.md` is the full spec.

- No framework, no build step, no npm runtime dependencies. `wrangler` is the only tool.
- Static pages live in `public/`; the Worker in `src/` handles `/api/*`.

## Requirements

- Node.js 18+ (only to run `npx wrangler` and `node --test`)
- A Cloudflare account (only needed when deploying — local dev works without logging in)

## 1. Create the Google service account (one time)

1. Open <https://console.cloud.google.com/> and create (or pick) a project.
2. **APIs & Services → Library** → enable **Google Sheets API**.
3. **APIs & Services → Credentials → Create credentials → Service account**. Give it a name (e.g. `sheets-work`); no roles needed.
4. Open the new service account → **Keys → Add key → Create new key → JSON**. A `.json` file downloads.
5. Copy the service account's email (`…@….iam.gserviceaccount.com`).
6. Open the **copy** sheet ("Copy of Video Editing Tracker") → **Share** → paste that email → **Editor** → uncheck "Notify" → Share.
   Do **not** share the live trackers with it.
7. The sheet has **protected ranges**, and they block the service account even though it is an Editor. As the sheet owner, go to
   **Data → Protect sheets and ranges**. For each protection below, click it → **Change permissions** → add the service-account email → Done:
   - `Coordinator Assign Task` (whole sheet): Assign / Re-assign
   - `Video Tracker-FMS!A1:X`: Editing done (column X)
   - `Video Tracker-FMS!AB1:AC`: Final done (column AC)
   - `Form responses 2` (whole sheet): New request
   - `Form responses 3` (whole sheet): file links

   The other protections (T, Z, AE:AH, A4:S, C3:L3 on the FMS tab, plus the `Video Tracker` and `Dashboard` tabs) can stay as they are.
   The app never writes there.

## 2. Local secrets — `.dev.vars`

`.dev.vars` is git-ignored. Fill in the three values:

```
GOOGLE_SA_KEY={...the whole service-account JSON on one line...}
ADMIN_PASSWORD=change-me
SESSION_SECRET=any-long-random-string
```

- `GOOGLE_SA_KEY`: paste the whole downloaded JSON **on one line**. Keep the `\n` sequences inside `private_key` as they are.
  To flatten it: `node -e "console.log(JSON.stringify(require('./key.json')))"` (then delete `key.json`).
- `SESSION_SECRET`: any long random string, e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

## 3. Commands

| What | Command |
|---|---|
| Run locally | `npx wrangler dev` → open <http://localhost:8787/login> |
| Unit tests | `node --test tests/` |
| Deploy (later) | `npx wrangler secret put GOOGLE_SA_KEY` (and `ADMIN_PASSWORD`, `SESSION_SECRET`), then `npx wrangler deploy` |

## Project layout

```
src/worker.js      router: /api/* → handlers; everything else is a static file
src/sheets.js      Google auth (JWT → token) + read/write/append
src/data.js        read FMS tab, build task objects, cache, role filtering
src/auth.js        login + signed session cookie
src/actions.js     assign / editDone / qcPass / qcReject / finalDone / addLink / newRequest
src/normalize.js   cleanup of departments, projects, people, priority, dates
public/            login.html, index.html (work queue), dashboard.html, css/, js/, img/
tests/             node:test unit tests
```

## Known data issues

- Cell **W7** in `Video Tracker-FMS` is `=0.5/1440`, so stage-1 planned time ≈ 1 second after assignment and almost every task
  looks late. The app shows this as is — it's a sheet setting.
- Some old tasks (e.g. TSK-391, TSK-519) have QC "Yes" before editing was done. Marking editing done clears that QC so QC isn't skipped.
- ~93 early tasks are "Done" without timestamps. They count as closed but are excluded from timing metrics.
- The "Click" / "Upload File" HYPERLINK formulas in the copy still point to the ORIGINAL Google Forms, which write to the LIVE sheet.
  The app never uses them.

## Status

Phases 1–5 done: Google connection (`/api/health`), data + cleanup (`/api/data`), login with roles, the
work queue with all actions, and the dashboard. Phase 6 (polish & review) is next.

- `/dashboard`: period filter, health score, KPI tiles, flags, Expert Desk, charts, people table, and a task list
  with the same action buttons as the queue (assign / re-assign / editing done / QC / final).
- Dashboard maths is in `public/js/kpi.js`, which has no DOM code and is unit-tested by `node --test tests/`.
- Shared task-row buttons live in `public/js/tasks-ui.js`, used by both pages.
- Flag "Acknowledge" is stored per browser (localStorage) for v1. It is not shared between people.

## How it works

- **Login:** editors pick their name; Admin enters `ADMIN_PASSWORD`. The session is a signed cookie that lasts 12 hours.
- **Doers** only ever receive their own rows. The server filters them, so changing the URL doesn't help.
  **Admin** sees everything and can "View as" any editor.
- **Actions:** every action re-reads the row from the sheet and re-checks role and stage before writing.
  Each successful action is logged to the `Action_Log` tab, which is created on first use.
- **Data cache:** the sheet is cached for 120 s. After an action, or when you click ↻ Refresh, it is re-read.
