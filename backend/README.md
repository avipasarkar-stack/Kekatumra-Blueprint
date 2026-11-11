# Kekatumra backend

API + static file server for the **माझं गाव केकतउमरा** website. It stores records in SQLite and
provides public survey and management endpoints. There are no user accounts.

- **No npm install needed.** Uses only Node's built-in modules (`node:http`, `node:sqlite`, `node:crypto`).
- **Needs Node.js 22.13 or newer.** (`node:sqlite` is still marked experimental by Node; the start script hides that warning.)
- Data lives in one SQLite file (`data/kekatumra.db`).

## Quick start

From the project directory, synchronize the maintained root frontend into the backend's
public-only directory, then run the server from `backend/`:

```bash
cd backend
npm run sync-frontend
npm start
```

Open http://localhost:3000. Run the tests with `npm test`. No `.env` file or npm
dependencies are required for local testing; Node.js 22.13 or newer is required.
`npm run sync-frontend` copies only the root `index.html` and `app.js` files into
`backend/public`. Run it again after changing either frontend source file.

The server's default static directory is `backend/public` when started from this
directory. Do not set `PUBLIC_DIR` to the project root: the public directory is
deliberately isolated from backend source, `.env`, and SQLite data.

## Public access

| Role | Can do |
|------|--------|
| Any visitor | Read and submit public suggestions, worker registrations and ratings; approve/reject pending submissions; view, create, edit, delete, export, and import family survey records. |

All API endpoints, including management and family data endpoints, are public. Do not enter real personal or sensitive information into this deployment.

## API

All request/response bodies are JSON. Errors look like `{ "error": "code", "message": "..." }`.
Use the `error` code in the frontend to show your own Marathi text.

### Public

| Method & path | Notes |
|---|---|
| `GET /api/health` | |
| `GET /api/suggestions` | Approved only. Name shown only if the person consented. Phone is never public. |
| `POST /api/suggestions` | `{category, text, consent, name, phone}` |
| `GET /api/workers?search=&skill=&contact=1` | Approved only, with `ratingAvg` / `ratingCount`. `phone` is included **only** if `contactConsent` is true. `contact=1` lists only consenting workers (for कौशल्य सेतू). |
| `POST /api/workers` | `{name, skill, experience, availability, area, description, phone, contactConsent}` |
| `POST /api/ratings` | `{workerId, stars (1-5), feedback}`. The worker must be approved. |

### Management (public)

| Method & path | Notes |
|---|---|
| `GET /api/admin/pending` | `{suggestions, workers, ratings}` waiting for review (includes contact details). |
| `POST /api/admin/queue/:kind/:id/approve` | `kind` = `suggestions`, `workers` or `ratings`. |
| `DELETE /api/admin/queue/:kind/:id` | Reject = delete (same as today's "नाकारून हटवा"). |

### Family survey (public)

| Method & path | Role | Notes |
|---|---|---|
| `GET /api/families?q=` | public | Search by house number, head, member names. |
| `GET /api/families/stats` | public | `{families, members, male, female, other, missing}` |
| `GET /api/families/:id` | public | |
| `POST /api/families` | public | `{record, acknowledge?}` |
| `PUT /api/families/:id` | public | `{record, baseSavedAt?, acknowledge?}` |
| `DELETE /api/families/:id` | public | |
| `GET /api/families/export` | public | Same JSON format as the current backup button. |
| `POST /api/families/import` | public | `{records, dryRun?}`. Additive only, never overwrites. `dryRun:true` = "JSON बॅकअप तपासा". |

`record` is the same flat object the form already builds (`houseNumber`, `familyHead`, `familyCount`, `member1_name`, ...).
The server re-checks the form's rules: required fields, gender, 10-digit mobiles, same person twice in one form.

**Duplicate handling** mirrors the current pop-ups:
- `409 duplicate_family` - same house + head + a matching member. Hard stop.
- `409 needs_confirmation` with `warnings: [{code, message, existing}]`. Show the message; if the user confirms, send the same request again with `"acknowledge": ["same_house_head", ...]` (the codes from the warnings).
- `409 conflict` on `PUT` - someone else saved the record after you opened it (send `baseSavedAt` = the `savedAt` you loaded).

## Frontend data and access

| Today (`localStorage` key) | Becomes |
|---|---|
| `keketUmraFamilyRecordsStage25V1` | `/api/families` |
| `keketUmraFamilySurveyDraftStage25V1` | Remains in `localStorage` as an unsaved draft only |
| `keketUmraVillageSuggestionsStage25V1` | `/api/suggestions` |
| `keketUmraSkilledWorkersStage25V1` | `/api/workers` |
| `keketUmraWorkerRatingsStage25V1` | `/api/ratings` (averages are returned with `/api/workers`) |
| Approval queue | `/api/admin/pending` and `/api/admin/queue/...` |

New family submissions are stored only in SQLite. Pre-existing family-record keys in
browser `localStorage` are not used for active records or deleted by the integrated frontend.
The "जुन्या ब्राउझर नोंदींचा JSON बॅकअप" action exports the old key without changing it.
Family deletion, JSON export/import, backup checks, and approval actions are public.

## Security notes

- **No authentication or authorization is enabled.** Anyone who can reach the server can read, alter, export, import, or delete family records and manage submissions.
- On the first server start after this change, legacy account and session tables are deleted; old audit-log account names are cleared. Family survey records are preserved.
- Public submissions: rate-limited per IP per hour (`SUBMIT_LIMIT_PER_HOUR`). Villages often share mobile-network IPs, so raise this if real users get blocked.
- Unsafe API requests must have a matching `Origin` when the browser sends one, and bodies must be `application/json`.
- All SQL is parameterised; field names in survey records are whitelisted by pattern; request bodies are size-limited (256 KB, 10 MB for import).
- Security headers and a Content-Security-Policy are set. The CSP allows `'unsafe-inline'` scripts because `index.html` still has inline JavaScript. Moving it to `app.js` lets you remove that.
- The server stores text as typed; the frontend must keep escaping it when rendering (your `esc()` function already does).
- Rate limits are in memory and reset when the server restarts.

## Deploying

1. Run it on a small VPS or Render/Railway with a **persistent disk** for `data/` (SQLite is a file; without a persistent disk the data disappears on redeploy).
2. Put it behind HTTPS (Caddy or nginx + Let's Encrypt). Set `NODE_ENV=production`, `TRUST_PROXY=true`, and make the proxy pass the `Host` and `X-Forwarded-For` headers.
3. Schedule `npm run backup` (daily cron) and copy the files off the server. Test restoring one: it is just a SQLite file.
4. Keep `HOST=127.0.0.1` when using a reverse proxy so the app is not reachable directly.

## Not included (and not solved by code)

- **Consent and privacy:** a legal consent form, privacy notice and data-retention rule are still needed. The survey holds names, birth dates and phone numbers, all of which are publicly accessible in this configuration. Do not collect real personal data unless that public exposure is intended and approved.
- CSV export and printing still happen in the browser (they work from `GET /api/families`).
