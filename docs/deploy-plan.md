# Plan: deploy Anketo to production

For a session starting cold. Everything you need to know is here; you should
not need to read the whole codebase first.

## What you are deploying

A static Vite site plus three Netlify Functions, using Netlify Blobs as the
only datastore. Repo: `abdelazer/anketo`. `netlify.toml` already declares the
build command, the publish directory, the `/api/*` rewrite and the SPA
catch-all — you should not need to change it.

```
netlify/functions/poll.mts     GET snapshot · POST create · PUT edit
netlify/functions/action.mts   POST start | next | complete | reset
netlify/functions/answer.mts   POST one answer
shared/poll.ts                 model + reveal/tally rules (imported by both halves)
shared/server.ts               Blobs access, validation, snapshot assembly
```

State of things as of writing: verified working end-to-end under `netlify dev`
(28 API assertions plus a manual three-tab browser pass). **Never deployed.**
The Netlify CLI is installed and logged in.

## The one real risk

`netlify/functions/*.mts` import from `../../shared/*`, which is **outside the
functions directory**. Locally the bundler resolves this fine. It is very
likely fine in production too — `netlify dev` uses the same zip-it-and-ship-it
/ esbuild path — but it has not been proven on Netlify's build image, and a
resolution failure there would take down the whole API while the static site
kept serving happily.

**So: deploy to a preview first and hit the API before touching production.**
If it does fail, the fix is `[functions] included_files` in `netlify.toml`, or
collapsing `shared/` into the functions directory.

## Steps

### 1. Create and link the site

```sh
netlify sites:create --name anketo        # name must be globally unique; adjust if taken
netlify link
```

Confirm with `netlify status` that the repo is linked to the site you expect.

### 2. Deploy a preview and prove the API works

```sh
npm ci && npm run build
netlify deploy            # draft URL, does NOT touch production
```

Against the draft URL, run the API suite that already exists. It currently
points at `localhost:8888`; parameterise the base URL rather than editing it
in place:

```sh
python3 docs/../scripts/api-smoke.py https://<draft-url>   # see note below
```

There is no `scripts/api-smoke.py` in the repo yet — the suite was written in
a scratch directory during the build session and not committed. Recreating it
is the first task of the **testing plan** (`docs/testing-plan.md`), which
specifies it in full. If you are deploying before that lands, the minimum
manual check is:

```sh
BASE=https://<draft-url>
ID=$(curl -s -XPOST $BASE/api/poll | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -s "$BASE/api/poll?id=$ID&view=create" | head -c 300   # must be JSON, not an error
```

A 500 here with a module-resolution error in the function log is the failure
mode described above.

### 3. Check Blobs behaves in production

Two things to verify rather than assume:

- **Strong consistency.** `shared/server.ts` requests
  `getStore({ name: 'anketo', consistency: 'strong' })`. The whole Leader→
  respondent handoff depends on it. Confirm a `next` action is immediately
  visible to a subsequent `GET`.
- **Deploy-preview isolation.** Previews may share the production Blobs store,
  since the code uses `getStore` rather than `getDeployStore`. Verify this
  before running preview traffic against a live poll — if they do share,
  either accept it, or switch to a deploy-scoped store for non-production
  contexts. Do not guess; check what a preview actually writes.

### 4. Promote to production

```sh
netlify deploy --prod
```

Then connect the GitHub repo in the Netlify UI so `main` auto-deploys, and
set Node to 20+ (the local build used Node 25; `netlify.toml` pins nothing).

### 5. Post-deploy smoke test, in a browser

The API suite does not cover the parts most likely to break on a real host:

- **QR code.** Lobby QR encodes `location.origin` — confirm it points at the
  production hostname, not localhost, and that a phone actually scans it.
- **Share buttons.** `navigator.share` and the clipboard fallback both need a
  secure context. They silently degrade on plain HTTP; production is HTTPS so
  this should work, but it has never been tested off localhost.
- **Two Lead devices.** Open `/lead` on a laptop and a phone, start a poll,
  and confirm the countdown→results flip happens at the same moment on both.
  This is the property most worth checking on real network latency.
- **Refresh mid-question** on all three modes.

### 6. Custom domain (optional)

Netlify DNS or an external CNAME; nothing in the app hardcodes a hostname.

## Free-tier limits to keep an eye on

- **125k function invocations/month.** Every poll tick is one invocation. The
  Fibonacci backoff and the hidden-tab pause exist to keep this small, but a
  30-person room polling for an hour is on the order of thousands. Fine for
  occasional use; worth measuring before anyone leans on it.
- **100GB bandwidth**, not a concern at ~17kB gzipped JS.
- **Blobs storage.** Answer keys from previous runs are orphaned rather than
  deleted (see README). Tiny, but unbounded over time.

## Rollback

`netlify rollback`, or publish a previous deploy from the UI. There are no
migrations — the data model is append-only per run, and `loadPoll` already
defaults a missing `run` field, so an older build will not choke on newer
documents.

## Explicitly out of scope

No auth, no rate limiting, no CSP headers, no poll expiry. All are reasonable
follow-ups; none are required to ship. Note that `/p/:id/create` and
`/p/:id/lead` are guessable from a Respond link by design — that was a
deliberate product decision, not an oversight.
