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
| Upcoming Bills | due today through 7 days out, nothing else |
| Revenue | collected or won Monday through today, not the whole pipeline |
| Revenue note | a conditional on how far off the goal is — no model call |

Everything is scoped to the `TIMEZONE` var rather than UTC, so "today" means
Ashley's today no matter where the page is open.

## Before you can deploy

These need gathering by hand — Claude Code can't complete an OAuth flow or
click through account settings.

**Anthropic** — API key from console.anthropic.com. Used only by the chat panel.

**ClickUp** — Settings → Apps → API Token. No OAuth app needed for a single
internal user. You also need the team id and the list ids for work and for
support tickets; `npx wrangler dev` plus a browser hitting
`https://api.clickup.com/api/v2/team` with the token will show you the team id,
and the list ids come from the ClickUp URL of each list.

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
to read access on the money hub (SIMoney), the bills base, and the content
planning base. You also need each base id (starts with `app`, visible in the
base URL) and the table names.

**Supabase** — project URL and the `service_role` key. That key bypasses row
level security, so it lives in Worker secrets and is never sent to the browser.

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

One more thing to check before the first deploy: `TIMEZONE` in `wrangler.toml`
is set to `America/New_York` as a guess. If that's wrong, every "today" and
"this week" on the dashboard is wrong with it.
