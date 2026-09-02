# Anketo

Snap polls for a room. Write a few questions, put a QR code on the shared
screen, and watch the answers land. No accounts, no apps, no database bill.

Built to run on a free Netlify account: a static Vite front end, three Netlify
Functions, and Netlify Blobs for storage.

## The three modes

Every mode is a real, refreshable URL, so anyone can reload or switch devices
mid-poll without losing their place.

| URL | Who it's for |
| --- | --- |
| `/p/:id/create` | The author: add, reorder and delete questions; set the timer |
| `/p/:id/lead` | The shared screen: QR code, questions, live results |
| `/p/:id/respond` | Everyone else, on their phone |

A bare `/p/:id` redirects to Respond, since that's what a stranger with the
link almost always wants.

## Running it

```sh
npm install
npm run dev        # netlify dev on :8888 — Functions and Blobs included
npm run build
npm run typecheck
```

`netlify dev` is required rather than plain `vite`: the API lives in Netlify
Functions and the store is Netlify Blobs, neither of which the Vite dev server
provides.

To deploy, connect the repo to Netlify — `netlify.toml` has the build command,
the Node version, the `/api/*` rewrite and the SPA catch-all already set. Then
check the deploy with

```sh
npm run smoke -- https://<deploy-url>
```

which takes seconds and asserts the things that are specific to being deployed
rather than to the logic. `docs/deploy-plan.md` is the full runbook.

The Blobs store holding live polls is reached only by an environment that
identifies itself as production or as local dev; anything else writes to a
store scoped to its own deploy. So a pull request's preview cannot touch a live
poll, and an environment nobody anticipated is isolated rather than trusted.

## How it works

### Results cannot leak early

The spec's hardest requirement is that nobody sees a distribution before the
countdown ends, or the room's answers get anchored. That is enforced in the
API, not by hiding a chart: `loadSnapshot` computes each question's reveal time
as `readyAt + durationSec` and only puts a tally on the wire once it has
passed. Before that, a Lead device receives a bare response *count* — useful to
a presenter, useless for anchoring. Respond mode never receives tallies at all.

### Two Lead devices stay in sync without talking to each other

A presenter often has Lead open on a laptop (projecting) and a phone
(controlling). Neither device stores "showing question" or "showing results" —
both *derive* it from `readyAtByQ` and the server clock, so they flip at the
same instant with no message passing and no write. Every client also tracks its
offset from server time on each poll, so a phone with a skewed clock still
counts down in step with the projector.

Leader controls are named actions (`start` / `next` / `complete` / `reset`)
rather than document writes, so both devices mean the same thing by them.
`next` carries the index it is advancing *from*, which makes a double-tap from
the second device a no-op instead of skipping a question nobody saw.

### Concurrent answers can't collide

Netlify Blobs has no transactions, and its conditional-write ETag isn't
returned by every runtime — the local dev emulator returns none, which silently
turns a compare-and-swap into a blind overwrite. (An early version of this
project lost 7 of 12 simultaneous answers that way.) So answers aren't stored in
one shared document. Each lands at its own key:

```
a/{pollId}/{run}/{questionId}/{deviceId}  ->  the answer
```

Exactly one device ever writes any given key, so there is nothing to race with
and no retry loop to get wrong. Two useful properties fall out of it:

- **Counts are free.** They come from the key listing alone, no reads. During a
  countdown — the busiest moment — a Lead refresh is a single `list` call.
- **Reset is O(1).** "Reset all answers" increments `run`, orphaning the
  previous session's keys in one write instead of deleting thousands. It also
  returns the poll to draft, which is what re-running it actually means.

The poll document itself does use read-modify-write, which is safe because its
writers are never concurrent: the editor is locked from Start Poll onward, and
simultaneous Leader taps are idempotent by construction.

### Polling

The spec's Fibonacci ladder — 1, 1, 2, 3, 5, 8, 13 seconds — capped at 13 and
reset to the start whenever anything actually happened (`rev` changed, a count
changed, a countdown expired, or the local device acted). It pauses on
`visibilitychange` and refetches immediately on wake, so a pocketed phone costs
nothing. When a countdown is due to expire before the next scheduled poll, the
store lands a fetch on the expiry instead, so results appear on zero rather
than up to 13 seconds later.

Every view also renders instantly from a `localStorage` snapshot of its last
state, then reconciles with the server a moment later.

### Smaller decisions

- **Options are shuffled per device**, seeded from `deviceId + questionId`, so
  the order is stable across re-renders and refreshes — reshuffling under
  someone's thumb mid-tap is worse than not shuffling. Lead and the charts use
  the author's canonical order.
- **Respondents move at their own pace.** The Leader making question 3 Ready
  never yanks question 2 away from someone mid-answer; they get a Next button.
  A phone joining late lands on the question the room is actually on.
- **One answer per device, changeable until the timer ends.** A latecomer may
  still answer a question whose countdown has passed, but nobody can change an
  answer once the room is looking at the results.
- **Create is read-only while a poll is running**, because reordering or
  deleting questions mid-flight would orphan recorded answers.
- **Text answers merge** on case, accents and punctuation when tallied, and
  display the most common original spelling ("New York", not "new york").

## Visual design

Lexend throughout, on `#614994`. That purple clears 7.4:1 against the light
surface; dark mode re-steps it to `#9b83d4`, which sits inside the validated
lightness band for the dark plane — both checked with a palette validator
rather than by eye.

Results are single-series, so there is one hue and no legend to decode. Rank is
carried by position and by the printed value, never by a color change, so an
option doesn't shift hue between questions. Text answers render as a response
wall rather than a scattered word cloud: identical answers merge, and
repetition drives size, emphasis *and* an explicit `×N` badge, so the popular
answers dominate visually while every answer stays readable and every count
stays checkable.

## Limits

Per poll: 50 questions, 10 options each, 400 devices per question, 140
characters per text answer. Polls have no expiry, and answer keys from previous
runs are orphaned rather than deleted — both fine at this scale, and worth
revisiting if this ever ran somewhere busy.

## Tests

```sh
npm test        # 38 API integration tests against a real netlify dev
```

`tests/setup/netlify-dev.ts` reuses a dev server already on :8888 or boots one
and tears it down after. Set `ANKETO_BASE_URL` to run the same suite against a
deploy preview. See `docs/testing-plan.md` for the layers that are still to be
written.
