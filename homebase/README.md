# Home Base

Ashley's internal dashboard, running on Cloudflare instead of inside a Claude
artifact. One Worker serves both the page and the API: static files come
straight off Cloudflare's edge, and everything that touches a real account sits
behind `/api` and a session cookie.

```
public/index.html + app.js     the dashboard, same layout as the artifact
src/index.js                   router and auth
src/routes/                    the four endpoints
src/services/                  one client per external API
src/lib/filters.js             the "due in 3 days" style rules, as plain code
src/chat/                      system prompt and the four read-only chat tools
scripts/google-oauth.mjs       one-time helper to mint a Google refresh token
test/                          tests for the filtering rules
```

## What changed from the artifact

The prototype asked Claude to go explore four MCP servers and hand back JSON.
That was the slowest and least predictable part of it. Here the Worker calls
each service's own API and computes the tiles in plain code, so a reload gives
the same answer twice and returns in about as long as the slowest upstream.
Claude is used for one thing: the chat panel.

The rules that used to live in prompt text now live in `src/lib/filters.js` and
have tests:

| Tile | Rule |
| --- | --- |
| My Tasks | assigned to Ashley, open, due within 3 days — overdue included and sorted first |
| Ready for Review | any ready-for-review status, due date ignored |
| Support Tickets | every open ticket counted; flagged once open longer than 2 days |
| Upcoming Bills | recurrence rules expanded across the next 7 days |
| Revenue | income dated Monday through today, excluding rows marked Unpaid |
| Revenue goal | read live from the Weekly Revenue Goals table |
| Client Projects | the Airtable roster, with health derived from its dates |
| Revenue note | a conditional on how far off the goal is — no model call |

Everything is scoped to the `TIMEZONE` var (`America/Chicago`) rather than UTC,
so "today" means Ashley's today no matter where the page is open.

### Two rules worth knowing about

**Bills are recurrence rules, not dated rows.** The Recurring Items table says
things like "monthly on the 20th" or "every 2 weeks from this anchor", so
`src/lib/recurrence.js` expands those into real dates across the next 7 days.
It handles monthly, weekly, every-2-weeks, quarterly, and one-time; a bill set
for the 31st still lands in February; and a rule whose anchor is in the future
does not appear before it starts. The `Active` checkbox is the off switch —
Airtable omits the field entirely when unchecked, which the code treats as off.

By default bills from all three books show (Solution Integrators, Tindall Tech,
Household). Set `AIRTABLE_BILLS_BOOKS` to `"Solution Integrators"` for business
only.

**Project health is derived from dates.** Project Status only ever says where a
project is (Invoice Paid, Execution, Ongoing Support), never whether it is in
trouble. So the card marks a project as needing attention when its
implementation date has passed while it is still being built, and as stalled
when its support end date has passed and it is not a retainer. Retainer clients
sit past their implementation dates by design and stay on track.

## Before you can deploy

These need gathering by hand — Claude Code can't complete an OAuth flow or
click through account settings.

**Anthropic** — API key from console.anthropic.com. Used only by the chat panel.

**ClickUp** — Settings → Apps → API Token. No OAuth app needed for a single
internal user. That is the only thing to gather; the ids are already filled in:

| Var | Value | What it is |
| --- | --- | --- |
| `CLICKUP_TEAM_ID` | `8619174` | the workspace |
| `CLICKUP_WORK_FOLDER_IDS` | `90147460136,44205760` | Client Projects, Ops Management |
| `CLICKUP_SUPPORT_LIST_IDS` | `900601724895` | Client Support Requests |

Work is scoped by **folder**, not by list, on purpose. Client Projects holds one
list per engagement and gains a new one with every client, so a list allowlist
would quietly drop each new client until someone edited the config. Support
points at the one ticket list; the Support folder also holds The Goodies Shop
and Repeat Client Project Requests, so if those should count as tickets, clear
`CLICKUP_SUPPORT_LIST_IDS` and set `CLICKUP_SUPPORT_FOLDER_IDS = "39953826"`
instead.

**Google Calendar** — the only service that genuinely needs OAuth. In Google
Cloud Console: create a project, enable the Calendar API, create an OAuth client
of type *Web application*, and add `http://localhost:8976` as an authorized
redirect URI. Then run the helper once on your own machine:

```
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run google-auth
```

It opens a consent screen, and prints a refresh token. That is a one-time step —
the Worker refreshes the short-lived access token itself from then on.

**Airtable** — a personal access token from airtable.com/create/tokens, scoped
to read access on these three bases. The base ids, table names, and field names
are already filled in from the live bases, so the token is the only thing to
gather:

| Base | Id | Used for |
| --- | --- | --- |
| SI Money Metrics | `appfVpfMqptf35xRa` | revenue, invoices owed, the client roster |
| 99 Problems But Money Aint One | `appQeUH0Lb6i3lxTL` | recurring bills, the weekly revenue goal |
| Solution Integrators Content Hub | `appzyaY40KNIy3n4t` | the content pipeline |

**Supabase — optional, and probably not needed.** The dashboard does not use it:
client projects come from Airtable's ALL Active Projects. It is wired up only so
the chat panel can answer questions about the client portal and LMS. Leave
`SUPABASE_URL` empty in `wrangler.toml` and the whole integration drops out,
including the `service_role` key — which is the most dangerous credential in the
set, since it bypasses row level security. Add it only if you want to ask the
chat panel about portal data.

## Setting it up

```bash
cd homebase
npm install
```

Fill in the non-secret configuration in `wrangler.toml` under `[vars]` — team
ids, base ids, table names, and the field names in each Airtable table. The
field names default to obvious guesses (`Amount`, `Due`, `Date`); correct them
to whatever the bases actually use. Nothing in `[vars]` is a secret.

Then set the secrets. These never go in the repo:

```bash
npx wrangler secret put DASHBOARD_PASSWORD    # something long
npx wrangler secret put SESSION_SECRET        # openssl rand -hex 32
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put CLICKUP_TOKEN
npx wrangler secret put AIRTABLE_TOKEN
npx wrangler secret put SUPABASE_SERVICE_KEY
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REFRESH_TOKEN
```

Optionally create the snapshot cache, so a reload paints the last known state
instantly while fresh data loads behind it:

```bash
npx wrangler kv namespace create SNAPSHOTS
```

Paste the returned id into the commented `[[kv_namespaces]]` block in
`wrangler.toml` and uncomment it. Skip this and the dashboard still works — it
just waits for live data every time.

```bash
npx wrangler deploy
```

For local work, copy `.dev.vars.example` to `.dev.vars`, fill it in, and run
`npm run dev`. `.dev.vars` is gitignored.

## Running the tests

```bash
npm test
```

These cover the filtering rules — the part most likely to drift as the ClickUp
and Airtable structures change. They run without any credentials.

## About the password gate

The brief didn't ask for auth, but a Worker on a public URL that reads ClickUp,
Airtable, Supabase, and a calendar shouldn't answer to anyone who finds the
address. So `/api/*` requires a session cookie signed with `SESSION_SECRET`, and
the page shows a password prompt until it has one. The session lasts 30 days.

That is the simple version. **Cloudflare Access in front of the Worker is
better** — it gives real Google sign-in, revocable sessions, and an audit log,
and it takes about five minutes to set up in the Zero Trust dashboard. Worth
switching to whenever it's convenient; the cookie gate can stay as-is
underneath, or come out entirely once Access is enforcing.

## Chat panel

Four read-only tools, backed by Worker functions: `search_clickup`,
`search_calendar`, `search_airtable`, `search_supabase`. It runs on
`claude-opus-5`. `CHAT_EFFORT` in `wrangler.toml` trades answer quality against
speed and cost — `low` for quick lookups, `high` when answers matter more than
latency.

There is deliberately no create, update, or delete tool. Adding one is a
separate piece of work with its own confirmation step, not something to slip in
next to a search.

## Failure behavior

A source that doesn't answer degrades its own card instead of blanking the
dashboard. The endpoint still returns 200 with the tiles it could compute, plus
a `warnings` array naming what failed, which the page shows as a line of small
grey text underneath. Missing configuration returns 503 with the name of the
var that isn't set, so a half-finished setup says which piece is missing rather
than failing mysteriously.

## Open questions for Ashley

- **Standalone, or a route inside the LMS Next.js app?** Built standalone here,
  since that is what this session had access to and it keeps the dashboard's
  deploys independent of the LMS. Folding it into the LMS later is mostly a
  matter of moving `src/routes` behind Next route handlers.
- **KV snapshot cache?** Built, and optional. Turning it on costs one KV
  namespace and makes reloads feel instant; leaving it off costs a few seconds
  of loading each visit.
- **LLM-written revenue note?** Left as a plain conditional. It reads fine and
  costs nothing. If you want a Claude-written line, it belongs as one small call
  in `src/routes/money.js` rather than in the dashboard's critical path.

One thing that changed once the real bases were read: the weekly revenue goal
in Airtable is $5,000, not the $7,500 hardcoded in the artifact. The dashboard
now reads the goal from the Weekly Revenue Goals table each week, so changing it
there changes the dashboard. `REVENUE_GOAL` is only the fallback for a week with
no row yet.
