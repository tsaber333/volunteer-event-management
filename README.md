# Volunteer Event Management App

Express + SQLite tooling for church and community volunteer sign-ups. Volunteers choose time slots or food prep items in a few simple steps, then get an emailed manage link to edit later. Admins build events and rosters in a Google-authenticated dashboard.

## Features at a glance

- Two signup modes: **schedule** (stations + time blocks) or **food prep** (categories + items that include dish names and “Others signed up” hints).
- Self-service manage links so volunteers can change or cancel without admin work.
- CSV exports (rosters, open needs, structure-only) and print-friendly rosters.
- Safe formatting for descriptions (bold/italic/bullets) without allowing HTML.
- Built-in help pages: public `/help`, admin `/admin/help/workflows`, and `/admin/help/formatting`.

## Quick start (local)

1. Install Node.js 18+.
2. Install dependencies: `npm install`
3. Copy env template: `cp .env.example .env`
4. Edit `.env`:
   - Set `SESSION_SECRET` to a long random string.
   - Set `APP_BASE_URL` to `http://localhost:3002` (or your host).
   - Fill in `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_WORKSPACE_DOMAIN` so admins can sign in.
   - Leave mail settings blank to log emails to the console, or provide real SMTP/Gmail creds.
5. Start the app: `npm run dev` (or `npm start` in production).
6. Open `http://localhost:3002` for public sign-ups. Admin dashboard lives at `/admin` after Google sign-in.

Run `npm run init-db` anytime to (re)create the SQLite schema in `db/volunteer.db`.

### Volunteer flow (what they see)
- The events list shows how many spots/items each event still needs.
- Step 1: Browse open slots (schedule) or items (food prep) and press “Sign up” on each one. Filters: view by station or time, show only open.
- Step 2: Enter contact info and choose who fills each spot (the registrant or “Someone else…”); food prep also asks for dish names. On wide screens Step 2 is pinned beside the list; on phones/tablets the “Continue” bar opens it as a slide-up panel.
- Confirm. The success page lists what was reserved and a manage link is emailed.
- The same person can’t take one slot twice or two overlapping slots, unless an admin turns on “Let one person sign up for time slots that overlap” in Edit event (`events.allow_overlap`, off by default). Rules are enforced on the server for sign-up, manage, and admin moves.
- Add to calendar: the thank-you page, manage page, and confirmation email (attached `.ics` plus a link) offer the group's slots as calendar entries — `GET /manage/:token/calendar.ics` (optionally `?block=<id>`) plus per-slot Google Calendar links. Times are converted from `APP_TIMEZONE` to UTC. Food Prep events get one entry (all-day if the event spans several days) listing everyone's dishes.
- Returning on the same device: a `signup_<eventId>` cookie (httpOnly, lasts `MANAGE_TOKEN_TTL_DAYS`) shows “You’re signed up…” at the top of the event page, with a “Not you?” button that forgets it.
- Signing up again with an email that already has a sign-up emails the manage link and holds the new picks in the session; opening the link in the same browser pre-loads them on the manage page.

### Admin notes
- Google OAuth is required; without credentials the login flow will fail.
- Events can be Draft (hidden), Private link (unlisted), or Public (listed on `/events`).
- Drag-and-drop ordering is available for stations, categories, and items.
- Use “Copy event” to clone structure without volunteers.

## Configuration highlights

| Variable | Purpose |
| --- | --- |
| `SESSION_SECRET` | Required; session signing key. |
| `APP_BASE_URL` | Full origin for OAuth callbacks and email links. |
| `DB_PATH` / `SESSION_DB_PATH` | Locations for data and session SQLite files. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_WORKSPACE_DOMAIN` | Google login for admins. |
| `MAIL_SERVICE` / `MAIL_HOST` / `MAIL_PORT` / `MAIL_USER` / `MAIL_PASS` | Outgoing email settings (console logging is used if none provided). |
| `APP_NAME`, `APP_TAGLINE`, `ORG_DISPLAY_NAME`, `BRAND_*`, `SUPPORT_CONTACT_*` | Branding and support info surfaced in headers, emails, and help pages. |
| `MANAGE_TOKEN_TTL_DAYS` | How long emailed manage links remain valid (default 30). |
| `APP_TIMEZONE` | IANA time zone that event times are entered in, used for calendar files and Google Calendar links (default `America/Vancouver`). B.C.'s switch to year-round UTC−7 from November 2026 is applied even on Node versions whose built-in time-zone data predates it. |

See `.env.example` for more options.

## Project layout

- `src/server.js` / `src/app.js` – Express bootstrap, middleware, routing.
- `src/controllers/` – Route handlers that call service methods.
- `src/services/` – Business logic for public/admin flows and email sending.
- `src/db/dal.js` – SQLite queries and migrations.
- `src/views/` – EJS templates for public and admin pages (including help).
- `src/public/` – Static assets.

## Testing

```bash
npx playwright install chromium   # first time only
npm test                          # unit tests, then browser tests (under 30 seconds)
npm run test:unit                 # just the quick Node tests in test/unit/
npm run test:e2e                  # just the browser tests in test/e2e/
```

- The browser tests start their own copy of the app on port 3199 (`TEST_PORT` to change it) with a fresh, seeded database in a temp folder, and stop it when they finish. They never touch `db/` or your `.env` data.
- With `NODE_ENV=test` the mailer never sends real email, even if SMTP settings are present; the browser tests read "sent" messages from an outbox file instead.
- Covered: events list counts, sign-up for a spot and for Food Prep, signing up family or only someone else, overlapping times blocked or allowed, the same email from another device, the remembered device and "Not you?", manage add/remove/clear, calendar download, and phone layout.
- A failing test leaves a screenshot and trace in `test-results/` (`npx playwright show-trace <file>`). Set `KEEP_TEST_DATA=1` to keep the temp database for a look afterwards.

## Contributing on GitHub

- Open a PR with a short summary, manual test notes (schedule + food prep), and screenshots for UI changes.
- Note any env var or migration changes.
- Keep accessibility and clear copy in mind; volunteers and coordinators may be non-technical.
