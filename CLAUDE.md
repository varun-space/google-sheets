# sheets-work — MeDa Video Ops Dashboard (Cloudflare Worker + Google Sheets)

You are building a small web app for the MeDa video editing team. Read this whole file before writing code.
Build in the PHASES at the bottom. Stop after each phase, tell me exactly how to test it, and wait for my OK.

---

## 1. Golden rules (never break these)

1. **Only ever touch the COPY sheet:** `1rTVnoyeqNIbUI_rPJ9zO6IwsO8-6og4G-NvO87uWmwM` ("Copy of Video Editing Tracker").
   These are LIVE sheets — never put them in code, config or tests:
   `19WNuW5djBphPTXWlweXokuePGdK_PgT2mIRPrLbQF44` (live video tracker), `1PxnC0v3U5xDbt3mnlEmoLwfL7bBca8Mk5SVv8uR6Ixw` (live design tracker).
2. **Simple stack only:** plain HTML + CSS + vanilla JS in `public/`, one Worker in `src/`. No React, no Astro, no build step,
   no bundler, no npm runtime dependencies. `wrangler` is the only dev tool.
3. **No `googleapis` library.** Talk to the Google Sheets REST API with `fetch`, authenticate with a service account
   by signing a JWT (RS256) with WebCrypto (`crypto.subtle`).
4. **Never write into a formula column.** Only the manual columns/tabs listed in §4 may be written.
5. **Server-side filtering.** A doer's browser must only ever receive that doer's rows. Never send everything and hide it in JS.
6. **Secrets never in code or git.** Locally they live in `.dev.vars` (git-ignored); in production they are `wrangler secret`s.
7. Keep files small and readable — a new developer must understand each file in 10 minutes. Comment the "why", not the "what".

---

## 2. Project structure

```
sheets-work/
├── CLAUDE.md
├── wrangler.jsonc
├── .dev.vars              ← local secrets (git-ignored)
├── .gitignore             ← .dev.vars, node_modules, .wrangler
├── src/
│   ├── worker.js          ← router: /api/* routes, everything else = static files
│   ├── sheets.js          ← Google auth (JWT → access token, cached) + read/write/append helpers
│   ├── data.js            ← read FMS, normalise, build task objects, cache
│   ├── auth.js            ← login, signed session cookie (HMAC-SHA256), role checks
│   ├── actions.js         ← assign, editDone, qcPass, qcReject, finalDone, addLink, newRequest
│   └── normalize.js       ← cleanup rules (departments, projects, people, priority, dates)
├── public/
│   ├── login.html         → /login
│   ├── index.html         → /        (Work queue — the main working page)
│   ├── dashboard.html     → /dashboard (KPIs, health score, charts, flags, expert desk, people table)
│   ├── css/style.css
│   ├── js/common.js       ← header + nav, session check, api() helper, i18n (EN/HI), toast, formatting
│   ├── js/queue.js
│   ├── js/dashboard.js
│   └── img/meda-partners-white.png, meda-partners-colour.png   (already provided)
└── tests/                 ← node:test unit tests for normalize.js, stage logic, KPI maths
```

`wrangler.jsonc`:
```jsonc
{
  "name": "sheets-work",
  "main": "src/worker.js",
  "compatibility_date": "2026-11-01",
  "assets": { "directory": "./public", "html_handling": "auto-trailing-slash" },
  "vars": { "SHEET_ID": "1rTVnoyeqNIbUI_rPJ9zO6IwsO8-6og4G-NvO87uWmwM" }
}
```
Static files are served first; anything without a file (e.g. `/api/data`) reaches the Worker.

`.dev.vars` (I fill these in — create the file with placeholders and tell me):
```
GOOGLE_SA_KEY={...the whole service-account JSON on one line...}
ADMIN_PASSWORD=change-me
SESSION_SECRET=any-long-random-string
```

---

## 3. Google Sheets access (sheets.js)

- Token: build JWT `{iss: client_email, scope: "https://www.googleapis.com/auth/spreadsheets", aud: "https://oauth2.googleapis.com/token", iat, exp: iat+3600}`,
  sign RS256 with the PKCS#8 `private_key` via `crypto.subtle.importKey('pkcs8', …)`, POST to `https://oauth2.googleapis.com/token`
  (`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`). Cache the token in a module variable until ~5 min before expiry.
- Read: `GET https://sheets.googleapis.com/v4/spreadsheets/{id}/values/{range}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`
  Use `values:batchGet` when reading several ranges. Dates come back as serial numbers.
- Write: `PUT .../values/{range}?valueInputOption=RAW` (body `{values:[[...]]}`).
- Append: `POST .../values/{range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`.
- **Dates/times:** Sheets serial numbers are **IST wall time**. Convert: `serial = (Date.now() + 5.5*3600*1000) / 86400000 + 25569`
  and back the same way. Write timestamps as serial numbers (RAW) — the columns are already date-formatted.
- Range names with spaces need quotes: `'Video Tracker-FMS'!A9:AI` (URL-encode the range).
- Wrap every Google call: on non-200 throw an Error with the Google message so the UI can show it.

---

## 4. The sheet — tabs, columns and how the workflow maps

### Tab `Video Tracker-FMS` (main data; header row 8, data from row 9)
Columns B–S and many others are **formulas mirrored from `Form responses 2`**. Read range `A9:AI`.

| Col | 0-based | Field | Type |
|---|---|---|---|
| A | 0 | Task-ID (`TSK-001`…) | formula |
| B | 1 | Timestamp (request time) | formula |
| D | 3 | Requester name | formula |
| E | 4 | Department (has emoji, e.g. "📣 Marketing") | formula |
| F | 5 | Project / Client | formula |
| G | 6 | Video Type | formula |
| H | 7 | Platform | formula |
| I | 8 | Duration | formula |
| J | 9 | Raw footage link | formula |
| K | 10 | Script / voiceover | formula |
| L | 11 | Captions | formula |
| M | 12 | Music | formula |
| N | 13 | Reference link | formula |
| O | 14 | Brief / instructions | formula |
| P | 15 | Output format | formula |
| Q | 16 | Preferred deadline | formula |
| R | 17 | Priority (e.g. "🔴 Urgent (Today)") | formula |
| S | 18 | Revision rounds | formula |
| T | 19 | **Assigned to** (lookup from Coordinator Assign Task) | formula |
| V | 21 | Assignment timestamp | formula |
| W | 22 | Stage 1 **Planned** | formula |
| X | 23 | Stage 1 **Actual** (editing done time) | **MANUAL — writable** |
| Y | 24 | Stage 1 Status ("Done") | **MANUAL — writable** |
| Z | 25 | Stage 1 delay | formula |
| AA | 26 | **QC** ("Yes" = passed, by Princy) | **MANUAL — writable** |
| AB | 27 | Stage 2 **Planned** | formula |
| AC | 28 | Stage 2 **Actual** (final output time) | **MANUAL — writable** |
| AD | 29 | Stage 2 Status ("Done") | **MANUAL — writable** |
| AE | 30 | Stage 2 delay | formula |
| AH | 33 | Editor name (copy of T) | formula |
| AI | 34 | Latest uploaded file link | formula |

Find a task's row by reading column A (`A9:A`) and matching the number in the ID (`TSK-391` → 391). Row = 9 + index.
Always re-read the row right before writing (state may have changed).

### Tab `Coordinator Assign Task` (assignment; header row 1)
`A Timestamp | B Email | C Task-ID | D Assigned to | E Planned Date (text "dd/MM/yyyy") | F Planned Time (text "HH:mm:ss") | G — | H TimeStamp (ARRAYFORMULA — never write)`
- FMS looks up the **first** match of the Task-ID → to re-assign, **update D of the existing row**; only append (A–F) if the task has no row.
- E and F are stored as **text** in existing rows — write them as text strings (RAW) to match.

### Tab `Form responses 2` (requests; banner rows 1–6, header row 7, data from row 8)
`A Timestamp | B Your Name | C Department | D Project | E Video Type | F Platform | G Duration | H Raw link | I Script | J Captions | K Music | L Reference | M Brief | N Output format | O Deadline | P Priority | Q Revisions | R Email | S — | T Task Id (ARRAYFORMULA) | U Uploaded File (ARRAYFORMULA)`
- New request = write A–R into the first empty row after the last non-empty A cell (row ≥ 8). Task ID is created by the T formula:
  **ID number = row − 7** (row 8 → TSK-001). Return it to the UI.
- The tab has ~53,000 empty grid rows — read only column A to find the last row.

### Tab `Form responses 3` (file uploads; header row 1)
`A Timestamp | B Task Id | C Upload File` → append `[serialNow, "TSK-391", link]`.

### Tab `Action_Log` (audit trail — create it via `spreadsheets:batchUpdate addSheet` if missing)
`Time | Who | Role | Action | Task | Details | Result` — append one row for every successful action.

### Workflow / stages (derive per task)
| Stage | Rule |
|---|---|
| `done` | AC has a value OR AD = "Done" |
| `un` (unassigned) | not done and T is blank |
| `working` (editing) | assigned, X blank and Y ≠ "Done" |
| `qcwait` | editing done (X or Y), AA ≠ "Yes" |
| `final` | AA = "Yes", not done |

Task-ID format for display/writes: `TSK-` + number padded to 3 digits (`TSK-007`, `TSK-391`, `TSK-1576`).

---

## 5. Roles and login (no PINs yet)

- **Login page:** dropdown of editor names (all distinct cleaned values of column T) + "🔐 Admin".
  Doer = pick own name (trust-based for now). Admin = must enter `ADMIN_PASSWORD`.
- Session = cookie `sw_session` containing base64 JSON `{role, name, exp}` + HMAC-SHA256 signature with `SESSION_SECRET`.
  `HttpOnly; Secure; SameSite=Lax; Path=/`, 12-hour expiry. `/api/logout` clears it.
- Every page loads `common.js`, which calls `/api/me`; no session → redirect to `/login`.
- 3 wrong admin passwords → 30-second lockout message (client side) + 800 ms server delay on failure.

| Role | Sees | Can do |
|---|---|---|
| doer | **only tasks where T = their name** (filtered on the server) | Editing done · Final done (+ optional file link) · Add file link — **own tasks only** |
| admin | everything + **"View as" dropdown** (shows exactly what a doer sees, with a "← Back to everyone" bar) | everything above for any task + Assign/Re-assign · QC pass · Send back · New request |

---

## 6. Actions (`POST /api/action` `{action, num, ...}`) — server re-checks everything

| Action | Who | Preconditions (re-read row first) | Writes |
|---|---|---|---|
| `assign` `{editor}` | admin | not done | Coordinator tab: update D of existing row, else append A–F |
| `editDone` | owner/admin | assigned; X blank; Y ≠ Done | X = now (serial), Y = "Done"; **if AA already "Yes", clear AA** (old data has pre-filled QC — must not skip QC) |
| `qcPass` | admin | X filled; AA ≠ Yes; not done | AA = "Yes" |
| `qcReject` | admin | X filled; not done | clear X, Y, AA (back to editing) |
| `finalDone` `{link?}` | owner/admin | X filled; AA = Yes; AC blank; AD ≠ Done; link (if given) starts with https:// | optional upload row → then AC = now, AD = "Done" |
| `addLink` `{link}` | owner/admin | link starts with https:// | append to Form responses 3 |
| `newRequest` `{name, project, ...}` | admin | name + project required | Form responses 2 A–R (dropdown values exactly as listed in §8) |

Return `{ok, msg}`; on success append to `Action_Log` and clear the data cache. Clear human messages, e.g.
"TSK-391: editing marked done — sent to QC." / "This task is not assigned to you."
Guard against formula injection: if a user-typed value starts with `= + - @`, prefix it with `'`.

---

## 7. Data endpoint (`GET /api/data`)

- Read FMS `A9:AI` once, cache the parsed result **in memory for 120 s** (module variable + timestamp); `?refresh=1` forces a re-read.
- Build tasks: `{num, id, ts, requester, dept, project, type, priority(0-4), person, p1, a1, p2, a2, qc, s1Done, s2Done, stage, odDays, tat, briefBlank}`
  plus `details` (platform, duration, raw, script, captions, music, ref, brief, format, deadline, revisions, file) **only for open tasks**.
- Doer → only own rows. Admin with `?as=Name` → same filtering as that doer (but still admin permissions).
- Response also includes: `editors`, `targets`, `owners`, `lastRequestAt`, `now`.
- Calculations may run in the browser (`dashboard.js`) on the already-filtered rows — that keeps the Worker simple.

### Normalisation (normalize.js) — port these exactly
- Strip emoji/variation selectors, collapse spaces, trim. Key = lowercase, `.`/`-`/`_` → space.
- **People:** Title Case ("geetanshu", "DEEP" → "Geetanshu", "Deep").
- **Departments** (regex on key, first match wins): `^(sm|smm)$|soc|ocial|social` → Social Media · `seo` → SEO · `^we?bi?s?i?te|^web` → Website ·
  `^mar?k[ea]?r?ting|^digital marketing` → Marketing · `^(tech|development)|tech ?/ ?dev` → Tech / Development · `^(hr)$` → HR · else Title Case · blank → "(Not specified)".
- **Projects** aliases: meyash/meyash hospital → Meyash Hospital · nature mania/naturemania → NatureMania · wayveda/way veda → Wayveda ·
  lifestyle/lifestyle channel → Lifestyle · psychology seekho/psycology seekho → Psychology Seekho · dr neha mehta/dr neha/neha mehta → Dr Neha Mehta ·
  ck/college knowledge/collegeknowledge → College Knowledge · dca/digital chaabi academy → DCA · dc/digital chaabi → Digital Chaabi ·
  hari har/harihar/hari har seeds → Hari Har · kissan ratan/kisan ratan → Kissan Ratan · my fit brain/myfitbrain/mfb → My Fit Brain ·
  asha mehta ki rasoi/asha mehta → Asha Mehta Ki Rasoi · life at meda → Life at MeDa · meda/meda partners → MeDa ·
  intimacy academy → Intimacy Academy · vibhor/dr vibhor → Dr Vibhor · else Title Case.
- **Priority:** contains urgent→0, high→1, normal→2, low→3, else 4 (labels Urgent/High/Normal/Low/Not set).
- **Video type:** emoji-stripped text as is.

### Overdue (odDays)
due = `working` → W (p1) · `qcwait` → X + `qcWaitHours` · `final` → AB (p2) or X · `un` → request time.
odDays = max(0, now − due) in days; "overdue" = assigned & odDays ≥ 2.

---

## 8. Pages and UI

**Design DNA (keep it calm, data-first):** fonts Sora (UI), Lora (headings), JetBrains Mono (numbers) from Google Fonts.
Colours: ink `#0e0e0e`, paper `#f7f4ee`, muted `#72685e`, rule `#e0d9ce`, light `#ede9e1`, red `#c0321e`, amber `#b86b00`, green `#1a6638`,
highlighter `#fff3a8`. Header = dark ink with **`img/meda-partners-white.png`** (set width only, ~96 px; never set both width and height).
Footer: "⚡ Built by MeDa Partners · Video Ops Dashboard · data as of {time}" and "MeDa Partners Pvt Ltd | www.meda.partners".
Mobile-friendly (grids collapse ≤720 px), print CSS, `prefers-reduced-motion` respected. Chart.js 4 from cdnjs only.
EN ⇄ HI toggle (Hinglish, Roman script) for all labels, stored in localStorage. Indian number format (K / L / Cr).

**/login** — logo, name dropdown, password field appears only for Admin.

**/ (Work queue)** — the main page.
- Admin bar: "View as" dropdown, "＋ New request" (modal), Log out. Doer bar: "Logged in as X", Log out.
- Stage filter pills: All open · Unassigned (admin) · Editing · Waiting QC · Final output.
- Table: ID (click ▸ to expand full details + "save file link" box) · Requested · Requester · Project · Type · Priority · Assigned (admin) · Stage pill · Late ("Xd late") · Action buttons per stage/role (§6).
- Buttons disable while saving; toast shows the server message; then reload data with `?refresh=1`. Confirm before Send back and Final done.
- New request modal dropdowns (write these exact values):
  Department: 📣 Marketing, 🎨 Creative, 🤝 Client Servicing, 👔 Management, 💻 Tech / Development, 💰 Sales, 👥 HR ·
  Type: 🎬 Reel / Short Form (under 60 sec), 📹 Long Form Video (1-10 min), 🎥 YouTube Video (10 min+), 📢 Ad Creative (Meta / Google), 📷 Shoot, 🎤 Talking Head / Interview, 🎞️ Product Demo / Explainer ·
  Platform: ▶️ YouTube, 📸 Instagram Reel, 🎯 Meta Ad (FB/IG), 🌐 Website Embed, 💼 LinkedIn, 📲 WhatsApp / Internal Use, 🎤 Event / Presentation ·
  Duration: ⚡ Under 30 sec, 🎬 30–60 sec, 📹 1–3 min, 🎥 3–10 min, 📽️ 10 min+, 🤷 Editor decide kare ·
  Priority: 🔴 Urgent (Today), 🟠 High (1-2 days), 🟡 Normal (3-5 days), 🟢 Low (this week) ·
  Format: 📱 Vertical 9:16 (Reels/Stories), 🖥️ Horizontal 16:9 (YouTube/Website), ⬜ Square 1:1.

**/dashboard** — date filter pills (This Month So Far [default] · Last Week · Last Month · Last 3 Months · Custom), then:
- **Health score ring (0–100):** 60 × avg(min(pace,1)) of target KPIs + 25 × (1 − critical flags/4, floor 0) + 15 × (no stale data). Green ≥75 "On track", amber 50–74 "Needs push", red <50 "Fire — act today".
- **KPI tiles** (value, ▲/▼ vs previous equal period, 6-period sparkline, status chip, progress bar vs target, owner):
  Requests (count, month-end pace) · Delivered (count) · Stage 1 on time % (a1 ≤ p1; target 85) · QC done % (admin only; target 95) ·
  Within turnaround % (request → final ≤ 24 h; target 50, i.e. median ≤ 24 h) · Overdue 2+ days (now; target 0).
  Exactly ONE tile gets the amber "🔍 Needs attention" outline (worst pace); if all ≥100% the best tile gets "🔥 Star metric". Clicking a tile scrolls to the matching task list.
- **Charts:** requests over time (daily ≤35 days, else weekly) · delivered + stage-1 on-time % by person (admin) · requests by department (top 8) · by type (top 8).
- **People table (admin):** person · delivered · open now · stage 1 on time · QC stage on time · median TAT · within target — green/amber/red cells.
- **Flags (list, severity order MOST CRITICAL → CRITICAL → RED FLAG → WATCH → POSITIVE)**, each with "→ Ask {owner}: {question}" and an Acknowledge button (store acks in a sheet tab `Acks` or skip in v1):
  overdue 2+ days (≥5 = most critical) · unassigned requests · no new request in 2 days (admin) · person stage-1 on-time <75% (≥10 tasks; <60% critical) ·
  urgent share >50% · backlog (delivered < 80% of requested) · blank dept/type >10% · median TAT above target · one editor >50% of output · positives (team ≥ target, person ≥97% with ≥15 tasks, requests up >20% with on-time holding).
  Doers only see their own overdue / on-time / star flags.
- **Expert Desk (admin, dark panel)** — "Creative Operations Head — 25 years running agency production": rule-based Suggestions / Bottlenecks / Pitfalls
  computed from the filtered data (template kit when one type >25%, batch the top requester >15%, pair weakest with strongest editor,
  stage-1 is the bottleneck when on-time < QC on-time −15 pts, urgent inflation, open queue ≥10, slow tail p90 > 3× target,
  QC skipped >10%, data hygiene, single point of failure, burnout = requests +15% & on-time −5 pts). One highlighted number per message; EN + HI.
- Detail table with tabs: Requested · Delivered · Open · Overdue · Stage 1 late · QC skipped, plus search.

**Owners/targets config** (in `src/data.js`, easy to edit):
`OWNERS = { coordinator: 'Video Coordinator', qc: 'Princy (QC)' }`
`TARGETS = { s1OnTime: 85, qc: 95, tatHours: 24, overdue: 0, qcWaitHours: 24, staleDays: 2 }`

---

## 9. Known data issues (handle them, and mention them in the README)
- Cell **W7** = `=0.5/1440` hours → stage-1 planned time ≈ 1 second after assignment, so almost every task looks "late". Show as is; it's a sheet setting.
- Some old tasks (TSK-391, TSK-519) have QC "Yes" before editing → handled in `editDone`.
- ~93 early tasks are "Done" without times → count as closed, exclude from timing metrics.
- The "Click"/"Upload File" HYPERLINK formulas in the copy still point to the ORIGINAL Google Forms (which write to the LIVE sheet) — the app must never use them.

---

## 10. Phases (stop after each one and wait for me)

**Phase 0 — scaffold:** create all folders/files above, `wrangler.jsonc`, `.gitignore`, `.dev.vars` with placeholders, a `README.md`
(setup + service-account steps + commands). `npx wrangler dev` must serve a placeholder `/login`.

**Phase 1 — Sheets connection:** `sheets.js` + `GET /api/health` that reads `'Video Tracker-FMS'!A9:A` and returns
`{ok, rows, lastTaskId}`. Expect ~1,576 tasks. Clear error if the key is wrong or the sheet isn't shared with the service account.

**Phase 2 — data + normalise:** `/api/data` (admin, no auth yet behind a temporary flag), tests in `tests/` for normalisers and stage logic
(`node --test`). Print counts by stage — expect roughly 1,532 done, ~20 editing, ~24 unassigned.

**Phase 3 — login + roles:** sessions, `/api/me`, `/api/logout`, doer filtering, admin "View as". Prove a doer cannot fetch other rows.

**Phase 4 — work queue + actions:** `index.html` + `queue.js` + `actions.js` + `Action_Log`. Test each action on one task in the copy and show me the changed cells.

**Phase 5 — dashboard:** `dashboard.html` + `dashboard.js` (KPIs, health ring, charts, flags, expert desk, people, detail table, EN/HI, print).

**Phase 6 — polish & review:** empty/loading/error states, mobile check, remove dead code, update README. Then STOP —
deploying to Cloudflare (`wrangler secret put …`, `wrangler deploy`) is a separate step I will ask for.
