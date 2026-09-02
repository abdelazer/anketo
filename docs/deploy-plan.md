# Deploying Anketo

For a session starting cold. Everything you need to know is here; you should
not need to read the whole codebase first.

This was a plan before anything shipped. The repo-side work it called for is
now done — see **What changed** at the bottom for the list — so what remains is
the operational sequence, which is short.

## What you are deploying

A static Vite site plus three Netlify Functions, using Netlify Blobs as the
only datastore. Repo: `abdelazer/anketo`. `netlify.toml` already declares the
build command, the publish directory, the Node version, the `/api/*` rewrite
and the SPA catch-all — you should not need to change it.

```
netlify/functions/poll.mts     GET snapshot · POST create · PUT edit
netlify/functions/action.mts   POST start | next | complete | reset
netlify/functions/answer.mts   POST one answer
shared/poll.ts                 model + reveal/tally rules (imported by both halves)
shared/server.ts               Blobs access, validation, snapshot assembly
scripts/smoke.mjs              the post-deploy check, against any base URL
```

State of things as of writing: 38 API tests green against `netlify dev`, plus a
manual three-tab browser pass. The Netlify CLI is installed and logged in.
**Never deployed.**

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
npm run smoke -- https://<draft-url>
```

`scripts/smoke.mjs` takes seconds and covers what is specific to being
deployed: the functions load at all, a write is readable back, `next` is
visible to the very next read, an answer round-trips, and no tally goes on the
wire before a countdown ends. Anything red here is a deploy problem, not a
logic problem — the logic has its own suite.

The slower, thorough option is that suite, pointed at the same URL:

```sh
ANKETO_BASE_URL=https://<draft-url> npm test
```

It waits out real countdowns, so it takes minutes. Run it once against the
first preview; after that the smoke script is enough per-deploy.

### 3. Check preview isolation before pointing traffic anywhere real

`shared/server.ts` now uses `getDeployStore` under `deploy-preview` and
`branch-deploy`, and `getStore` otherwise, so a preview writes to its own
store and cannot touch a live poll. Verify it holds on the real backend rather
than trusting the local emulator:

```sh
npm run smoke -- https://<draft-url> --isolated-from https://<prod-url>
```

The extra check creates a poll on the preview and asserts production returns
404 for its code. If it returns 200, the two are sharing a store and the
context detection is not firing — check what `CONTEXT` is actually set to in
the function log before running any preview traffic.

### 4. Promote to production

```sh
netlify deploy --prod
npm run smoke -- https://<prod-url>
```

Then connect the GitHub repo in the Netlify UI so `main` auto-deploys.

### 5. Post-deploy smoke test, in a browser

Neither suite covers the parts most likely to break on a real host:

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
  deleted (see README), and every smoke run leaves a draft poll behind. Tiny,
  but unbounded over time.

## Rollback

`netlify rollback`, or publish a previous deploy from the UI. There are no
migrations — the data model is append-only per run, and `loadPoll` already
defaults a missing `run` field, so an older build will not choke on newer
documents.

## What changed to make this deployable

Four things, all in the PR that turned this plan into a runbook:

- **The functions bundle cleanly.** The original worry was that
  `netlify/functions/*.mts` import from `../../shared`, outside the functions
  directory, and that this had only ever been proven under `netlify dev`.
  It holds: `netlify build` then unzipping `.netlify/functions/poll.zip` shows
  esbuild inlines `shared/` into the function and leaves no relative import
  behind — the only surviving import is `@netlify/blobs`, vendored into the
  zip. Worth re-checking that way if the bundler config ever changes.
- **`@netlify/blobs` moved to `dependencies`.** It was a devDependency, which
  worked only because Netlify installs those by default. Any build configured
  to skip dev dependencies would have shipped functions that cannot start.
- **Node is pinned** to 22 in `netlify.toml`. Nothing was pinned before, so a
  build-image default could have moved under the site.
- **Preview deploys got their own Blobs store**, as described in step 3. The
  code used `getStore` unconditionally, which is site-global: every preview
  would have been reading and writing production's live polls.

## Explicitly out of scope

No auth, no rate limiting, no CSP headers, no poll expiry. All are reasonable
follow-ups; none are required to ship. Note that `/p/:id/create` and
`/p/:id/lead` are guessable from a Respond link by design — that was a
deliberate product decision, not an oversight.
