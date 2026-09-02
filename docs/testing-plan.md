# Plan: automated testing for Anketo

For a session starting cold.

**Status: layer 3 (API integration) is implemented and passing** — 38 tests in
`tests/api.test.ts`, run with `npm test`. Layers 1, 2, 4 and 5 are not written
yet; the assertions below are the specification for them.

This document exists because everything here was verified once, by hand, in a
session whose context is now gone — the assertions are written out in full so
they can be implemented without rediscovering them.

## Why this matters here

Two things about this codebase resist casual testing, and both have already
caused a real bug or a near miss:

1. **Almost every rule is time-dependent.** "Has this question been revealed"
   is a function of server time, and it is the hinge the whole product turns
   on. Tests that `sleep()` will be slow and flaky; tests that inject a clock
   will be neither.
2. **Concurrency is a correctness property, not a performance one.** The first
   implementation stored all answers in one blob guarded by a compare-and-swap.
   It lost **7 of 12 simultaneous submissions**, because Netlify Blobs does not
   return an ETag in every runtime and the conditional write silently degraded
   to a blind overwrite. Nothing about a single-threaded test would have caught
   that. A concurrency test is non-negotiable and should be treated as a
   regression test for a bug that actually shipped into a working tree.

## Tooling

- **Vitest** for unit, server-logic and API tests. It shares Vite's transform
  pipeline, so `shared/*.ts` needs no extra build config, and its fake timers
  handle the client store.
- **Playwright** for end-to-end, specifically because it can drive *multiple
  independent browser contexts* in one test. That is the only way to test the
  two-Lead-devices requirement, which is this app's most distinctive behaviour.
- **No mocking framework for Blobs.** Test the real thing against
  `netlify dev`. Mocking the store would have hidden the ETag bug entirely.

## Step 0 — seams to introduce first

Do this before writing tests; retrofitting is worse.

**Inject the clock into the server.** `shared/poll.ts` is already clean — every
time-dependent function (`revealAt`, `isRevealed`, `secondsLeft`,
`acceptsAnswers`, `tallyQuestion`, `normalizeText`) is pure and takes `now` as
a parameter, so it is testable as-is. The problem is `shared/server.ts` and the
three functions, which call `Date.now()` directly in `loadSnapshot`,
`updatePoll`, `advanceTo` and the reveal check in `answer.mts`. Thread a
`now: () => number` through, defaulting to `Date.now`.

**Give the API tests a base URL.** Nothing should hardcode `localhost:8888`.

**Consider extracting the key-layout functions** (`RUN_PREFIX`, `Q_PREFIX`, and
the parsing in `listAnswerKeys`) so key construction and parsing can be tested
as a round trip without a store.

---

## Layer 1 — pure units (`shared/poll.ts`, `src/device.ts`, `src/pacing.ts`)

Fast, no I/O, no clock. These should be the bulk of the suite.

`src/pacing.ts` is covered (`tests/pacing.test.ts`): auto-advance moves a
respondent's screen for them, so its refusals — an unanswered question, a
countdown still running, a position level with or ahead of the Leader — are
asserted alongside the case it accepts. The rest of this layer is still to
write.

### Reveal and timing
- `revealAt` returns `readyAt + durationSec * 1000`.
- `revealAt` returns `null` for a question never made Ready — **not** 0, and
  not a past timestamp. A null-vs-zero mistake here would reveal every unasked
  question at once.
- `isRevealed` is false one millisecond before, true exactly at the boundary.
- `secondsLeft` ceils (2001ms remaining reads as "3", never "2"), floors at 0,
  and returns 0 for a question that was never Ready.

### Answer eligibility
- `acceptsAnswers` is false when phase is `draft` or `complete`.
- True for the current question and every earlier one.
- **False for a question beyond `currentIndex`** — a respondent must not be
  able to answer ahead of the room.
- False for an unknown question id.

### Text normalisation
- Case, surrounding whitespace, internal whitespace runs, punctuation and
  accents all collapse: `Busy`, `busy!`, `  BUSY  ` are one group; `Café` and
  `cafe` are one group.
- A string that normalises to empty (`"!!!"`) falls back to its lowercased
  form rather than merging with every other punctuation-only answer.

### Tallies
- **Choice:** counts are in canonical author order, zero-count options are
  present (the chart needs them), and `total` equals the number of devices.
- **Text:** groups are sorted by count descending, ties broken alphabetically
  so output is deterministic.
- **Text:** the *most common original spelling* is displayed — six answers of
  `Focus`/`focus`/`FOCUS!` weighted toward `Focus` must display `Focus`, not a
  normalised key.
- Empty and whitespace-only text answers are excluded.
- A tally over zero answers returns `total: 0` and does not throw.

### Seeded shuffle (`src/device.ts`)
- Same `(items, seed)` returns the identical order every call — this is what
  keeps options from reshuffling under someone's thumb.
- Different seeds produce different orders (over a sample; do not assert on a
  single pair).
- The result is always a permutation: same length, same members.

---

## Layer 2 — server logic (`shared/server.ts`)

Pure functions, no store needed.

### `sanitizeDraft`
- `durationSec` clamps to 1–300; non-numeric falls back to the existing value.
- Prompts truncate at 200, options at 80, questions at 50, options at 10.
- Missing or malformed question/option ids are regenerated.
- **Duplicate ids are de-duplicated** — two questions sharing an id would
  silently merge their answers.
- Run-state fields (`phase`, `currentIndex`, `readyAtByQ`, `run`, `id`,
  `createdAt`) are preserved from the base and cannot be overwritten by the
  client payload. Assert this explicitly with a hostile payload that tries.
- A `text` question ends up with no options regardless of what was sent.

### `sanitizeAnswer`
- A choice value not among the question's option ids is rejected.
- Empty or whitespace-only text is rejected.
- Text truncates at 140.

### `assertDeviceId` — treat as a security test
Device ids are interpolated directly into blob keys. Assert rejection of:
`../../polls/someid`, ids containing `/`, empty string, a 5000-character
string, and non-strings. A passing `/` here would let a client write outside
its own key space.

### `revealedForView`
- `create` and `respond` always get an empty list, even for revealed questions.
- `lead` mid-run gets **only the current question**, never earlier revealed
  ones (that would be wasted reads).
- `lead` when `complete` gets every revealed question.
- A question whose countdown is still running is never in the list.

---

## Layer 3 — API integration (against `netlify dev`) — **DONE**

Implemented in `tests/api.test.ts` (38 tests, ~35s). `tests/setup/netlify-dev.ts`
reuses a dev server already listening on :8888, or boots one and tears it down
afterwards, so `npm test` works from a cold checkout. Point it elsewhere with
`ANKETO_BASE_URL` to run the same suite against a deploy preview.

Two conventions worth keeping if you extend it: ids are always read back from
the response rather than assumed (the server regenerates any id that does not
match its shape, and an early version of this suite silently tested a poll
whose questions it had never written), and `waitForReveal` sleeps against the
*server's* clock rather than a fixed wall-clock interval.

The assertions, all covered:

### Lifecycle
1. `POST /api/poll` returns a 7-character id and a draft poll with one blank
   choice question.
2. `PUT` assigns ids to id-less questions and options.
3. `PUT` with a stale `rev` is refused with 409.
4. `next` before `start` is refused with 409.
5. `start` sets phase `active`, `currentIndex` 0, and stamps `readyAtByQ`.
6. `start` on an already-active poll is a no-op, and **does not restart the
   countdown** — two Lead devices both tapping Start must not extend the timer.
7. `start` is refused when a question has an empty prompt, or a choice question
   has fewer than two non-empty options.
8. `complete` sets phase `complete`.

### The reveal gate — the most important group
9. Before reveal, `view=lead` returns correct `responseCounts` and an **empty**
   `tallies` object.
10. After reveal, `view=lead` returns the tally for the current question.
11. `view=respond` returns **no tallies at any time**, before or after reveal.
12. `view=respond` returns `mine` containing only the requesting device's
    answers, and never another device's.
13. `view=create` returns no tallies.

### Concurrency — regression test for a shipped bug
14. **12 (ideally 50) simultaneous `POST /api/answer` calls from distinct
    devices all return 200 and all land.** Assert the count equals the number
    of requests. This is the test that would have caught the ETag bug.
15. Simultaneous writes from distinct devices to *different* questions all land.

### Answer rules
16. An answer is changeable while the countdown runs, and the tally moves
    buckets correctly (assert the full distribution, not just the total).
17. Changing an answer after reveal is refused with 409.
18. A device answering for the **first** time after reveal is accepted — this
    latecomer path is easy to break while fixing the previous rule.
19. An option id not belonging to the question is refused with 400.
20. Answering a question beyond `currentIndex` is refused.

### Two Lead devices
21. Two `next` calls both carrying `index: 0` advance to question 1 **once** —
    the second is a no-op, not a skip to question 2.
22. A `next` carrying a stale index lower than `currentIndex` is a no-op.

### Reset
23. `reset` returns the poll to draft, zeroes counts, and preserves questions.
24. `reset` increments `run`.
25. **Answers written before a reset are unreachable afterwards**, and a late
    submission racing the reset does not appear in the new run.
26. Answering a poll that is back in draft is refused with 409.

### Validation and errors
27. An unknown poll id returns 404 with a readable message.
28. Editing a running poll is refused with 409.
29. Duration, prompt length and duplicate-option-id sanitising all hold over
    the real API, not just the unit under test.
30. A hostile draft save cannot move the poll's run state — `phase`,
    `currentIndex`, `run` and `readyAtByQ` are ignored from the payload.
31. **Completing a poll does not reveal a question whose countdown never
    expired.** Found by a failing test while porting this suite: reveal is a
    function of the countdown, not of the poll being over, so cutting a poll
    short must not hand the room answers it never earned.

---

## Layer 4 — client store (`src/store.ts`), Vitest + fake timers

Mock `fetch`; drive `vi.advanceTimersByTime`.

- **Ladder shape.** With an unchanging server response, successive polls occur
  at 1, 1, 2, 3, 5, 8, 13 seconds and then stay at 13 — assert the actual
  delays, not just "it polls".
- **Ladder reset.** A change in `rev`, in `responseCounts`, or in the set of
  revealed questions returns the interval to 1s.
- **Landing on reveal.** With the ladder at 13s and a countdown expiring in
  4s, the next fetch happens at ~4s, not 13s.
- **Clock offset.** Given `serverTime` ahead of local `Date.now()`,
  `serverNow()` compensates, and `secondsLeft` computed from it is correct.
- **Hidden tab.** `document.hidden` true stops scheduling; the
  `visibilitychange` back to visible triggers an immediate fetch and resets
  the ladder.
- **404 is terminal** — the store stops polling for a poll that does not exist.
- **Network failure is not terminal** — it backs off, sets `offline`, keeps
  the last good snapshot, and recovers on success.
- **Cache round trip.** A snapshot written to `localStorage` is restored on
  construction, and a cache entry for a *different* poll id is ignored.
- All `localStorage` access survives an exception (private mode) — assert by
  making the storage getter throw.

---

## Layer 5 — end-to-end (Playwright)

Few, slow, high value. Use a short `durationSec` (2–3s) to keep them quick.

1. **Full happy path.** Create a poll with one choice and one text question →
   Lead → Start → two respondent contexts answer → countdown expires → Lead
   shows the bar chart with the right distribution → Next → text answers →
   response wall → Complete → summary shows both.
2. **Two Lead devices flip together.** Two Lead contexts on the same poll;
   after the countdown both show results within ~1s of each other. Then press
   Next on the *second* device and assert the first follows.
3. **Respondent pacing.** With the Leader on question 2, a respondent still
   answering question 1 is *not* dragged forward while its countdown runs. Once
   question 1 locks, a respondent who answered it lands on question 2 by
   itself, and one who never answered stays put with a Next button and the
   "you can still answer" offer intact. The decision itself is covered by
   `tests/pacing.test.ts`; what only E2E can show is that the screen actually
   moves, and that the confirmation is readable before it does.
4. **Refresh mid-countdown** on Lead and on Respond resumes with the correct
   remaining seconds (assert it is close to expected, not exact).
5. **Shuffle stability.** A respondent's option order is identical after a
   reload, and two respondent contexts get different orders.
6. **Latecomer.** A device joining after a countdown expired can still submit
   a first answer, and sees "Time is up, but you can still answer."
7. **Waiting screen** appears for a respondent on a draft poll and advances on
   its own once the Leader starts.
8. **Create is locked** while the poll is active.

Worth adding but lower priority: an `axe-core` pass on each of the three modes,
and a check that the lobby QR encodes the page's own origin.

---

## What not to test

- Exact pixel output of the bar chart or response wall. Assert the data
  (percentages, ordering, `×N` counts) and let design change freely.
- The QR module's internals — it is a vendored library. Test only that an
  `<svg>` appears and encodes the right URL.
- Netlify Blobs itself.
- CSS token values. The palette was validated once with a contrast checker;
  re-run that tool if the palette changes rather than asserting hex codes.

## CI

GitHub Actions on push and PR: `npm ci`, `npm run typecheck`, `npm run build`,
Vitest unit + server layers, then `netlify dev` in the background for the API
layer, then Playwright. Keep layers 1–2 in a job that finishes in seconds so
most failures report fast; let 3–5 run separately.

## Suggested order

1. ~~Layer 3~~ — done.
2. Layer 1 and 2 (pure) — cheapest, and they lock down the reveal and tally
   rules everything else depends on. Layer 3 exercises them only through HTTP,
   so the edge cases (null vs zero in `revealAt`, `secondsLeft` ceiling,
   shuffle determinism) are still unguarded.
3. E2E scenarios 1 and 2 — the two-Lead-device flip is the one behaviour no
   other layer can reach.
4. Layer 4 (client store), then the remaining E2E.

**CI is not wired up yet.** The blocker to check first: whether `netlify dev`
will start in a GitHub Actions runner without Netlify credentials. It works
locally against an unlinked site, which suggests the Blobs emulator is purely
local, but that has not been confirmed — do not assume it.
