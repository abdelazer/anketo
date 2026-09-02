#!/usr/bin/env node
/**
 * Post-deploy smoke test — the first thing to run against a fresh deploy.
 *
 *   npm run smoke -- https://<deploy-url>
 *   npm run smoke -- https://<preview-url> --isolated-from https://<prod-url>
 *
 * This is deliberately not the test suite. `npm test` is thorough but waits out
 * real countdowns, so it takes minutes; this takes seconds and answers the two
 * questions that are actually specific to being deployed:
 *
 *   1. Do the functions run at all? They import from `../../shared`, outside
 *      the functions directory. esbuild inlines it — verified by unzipping
 *      `.netlify/functions/poll.zip` after `netlify build` — but a bundler
 *      change would surface here as a 500 on the very first call.
 *   2. Is the store strongly consistent on the real backend? The whole
 *      Leader→respondent handoff assumes a write is visible to the next read.
 *      The local emulator is a single process and cannot disprove it.
 *
 * `--isolated-from` additionally proves a preview deploy writes to its own
 * store: a poll created on the preview must not be readable on production.
 * Run it before pointing any preview traffic at a live poll.
 *
 * Every poll it creates is left behind, as ~1kB of draft that nobody has the
 * code to. That is cheaper than a delete endpoint that exists only for tests.
 */

const args = process.argv.slice(2)
const flagIndex = args.indexOf('--isolated-from')
const base = trimSlash(args[0])
const other = flagIndex === -1 ? undefined : trimSlash(args[flagIndex + 1])

if (!base || base.startsWith('--') || (flagIndex !== -1 && !other)) {
  console.error('usage: npm run smoke -- <base-url> [--isolated-from <other-base-url>]')
  process.exit(2)
}

function trimSlash(value) {
  return value?.replace(/\/+$/, '')
}

let failures = 0

/**
 * Report and keep going: one run should surface every problem, not the first.
 * `detail` is only printed on failure — it is the response body or the reading
 * that disproves the check, which is noise when the check passed.
 */
function check(name, passed, detail = '') {
  console.log(`${passed ? '  ok  ' : ' FAIL '} ${name}${passed || !detail ? '' : ` — ${detail}`}`)
  if (!passed) failures += 1
  return passed
}

async function call(url, method, body) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    // An HTML body here is the tell that /api/* fell through to the SPA
    // catch-all instead of reaching a function.
    parsed = { error: `not JSON: ${text.slice(0, 200)}` }
  }
  return { status: response.status, body: parsed }
}

const api = (root) => ({
  create: () => call(`${root}/api/poll`, 'POST'),
  snapshot: (id, view = 'lead') => call(`${root}/api/poll?id=${id}&view=${view}`, 'GET'),
  save: (id, rev, poll) => call(`${root}/api/poll`, 'PUT', { id, rev, poll }),
  act: (id, action, index) => call(`${root}/api/action`, 'POST', { id, action, index }),
  answer: (id, questionId, deviceId, value) =>
    call(`${root}/api/answer`, 'POST', { id, questionId, deviceId, value }),
})

async function main() {
  const it = api(base)
  console.log(`\nsmoke: ${base}\n`)

  // 1. The functions load, and the store accepts a write.
  const created = await it.create()
  if (
    !check('POST /api/poll creates a poll', created.status === 201 && !!created.body.id, describe(created))
  ) {
    console.error(
      '\nThe API is not answering. Check the function log for a module-resolution\n' +
        'error on ../../shared — if that is it, the fix is `included_files` in\n' +
        'netlify.toml, or moving shared/ inside the functions directory.\n',
    )
    return
  }
  const id = created.body.id
  console.log(`  poll ${id}`)

  // 2. That write is readable back.
  const fetched = await it.snapshot(id, 'create')
  check('GET /api/poll reads it back', fetched.status === 200 && fetched.body.poll?.id === id, describe(fetched))

  // 3. A real poll, so the action endpoints have something to act on.
  const saved = await it.save(id, fetched.body.poll?.rev, {
    title: 'Smoke test',
    durationSec: 5,
    questions: [
      { type: 'choice', prompt: 'First?', options: [{ text: 'A' }, { text: 'B' }] },
      { type: 'choice', prompt: 'Second?', options: [{ text: 'C' }, { text: 'D' }] },
    ],
  })
  if (!check('PUT /api/poll saves a draft', saved.status === 200, describe(saved))) return
  const questions = saved.body.poll.questions

  // 4. Strong consistency, the property the handoff depends on: `next` must be
  //    visible to the very next read, with no delay and no retry.
  await it.act(id, 'start')
  const advanced = await it.act(id, 'next', 0)
  check('POST /api/action advances', advanced.body.poll?.currentIndex === 1, describe(advanced))

  const afterNext = await it.snapshot(id, 'lead')
  check(
    'the next read sees it (strong consistency)',
    afterNext.body.poll?.currentIndex === 1,
    `currentIndex=${afterNext.body.poll?.currentIndex}`,
  )

  // 5. An answer round-trips, which is the one write path that is not the poll
  //    document — a different key layout, and the only one a room hits at once.
  const device = 'smoke-device-0001'
  const answered = await it.answer(id, questions[1].id, device, questions[1].options[0].id)
  check('POST /api/answer accepts an answer', answered.status === 200, describe(answered))
  check(
    'the answer is counted',
    answered.body.responseCounts?.[questions[1].id] === 1,
    `count=${answered.body.responseCounts?.[questions[1].id]}`,
  )

  // 6. The reveal gate still holds on a real host: a Lead snapshot taken while
  //    an answer is already in must carry the count but not the distribution.
  //    This is the product's hardest requirement, and a caching layer in front
  //    of the functions is exactly the kind of deploy-only change that breaks
  //    it — so it is worth re-asserting here and not only in the suite.
  const midCountdown = await it.snapshot(id, 'lead')
  check(
    'Lead sees the response count',
    midCountdown.body.responseCounts?.[questions[1].id] === 1,
    describe(midCountdown),
  )
  check(
    'no tally before the countdown ends',
    midCountdown.body.tallies?.[questions[1].id] === undefined,
    'a distribution was on the wire early',
  )

  // 7. Preview isolation: production must not be able to see this poll.
  if (other) {
    const leaked = await api(other).snapshot(id, 'lead')
    check(
      `${other} cannot see this poll (separate store)`,
      leaked.status === 404,
      `got ${leaked.status} — the two deploys share a Blobs store`,
    )
  }
}

function describe({ status, body }) {
  return `${status} ${JSON.stringify(body).slice(0, 160)}`
}

main()
  .catch((error) => {
    console.error(`\nsmoke run threw: ${error.message}`)
    failures += 1
  })
  .finally(() => {
    console.log(failures === 0 ? '\nall checks passed\n' : `\n${failures} check(s) failed\n`)
    process.exit(failures === 0 ? 0 : 1)
  })
