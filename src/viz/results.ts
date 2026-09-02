import { h } from '../dom'
import type { ChoiceTally, Tally, TextTally } from '../../shared/poll'

/**
 * Result views.
 *
 * Both are single-series: one measure, one hue (the brand purple), so there is
 * no legend to read and no color-matching to do. Rank is carried by position
 * and by the printed value — never by a color change, which would make the same
 * option shift hue between questions.
 */

export function renderTally(tally: Tally): HTMLElement {
  return tally.type === 'choice' ? renderBars(tally) : renderCloud(tally)
}

export function renderBars(tally: ChoiceTally): HTMLElement {
  // Highest first, per spec; ties keep the order the author wrote them in.
  const rows = tally.counts
    .map((row, index) => ({ ...row, index }))
    .sort((a, b) => b.count - a.count || a.index - b.index)

  const total = tally.total

  return h(
    'ul',
    { class: 'bars', role: 'list' },
    ...rows.map((row, rank) => {
      const share = total > 0 ? row.count / total : 0
      const percent = Math.round(share * 100)

      return h(
        'li',
        {
          class: rank === 0 && row.count > 0 ? 'bar-row bar-row--lead' : 'bar-row',
          role: 'listitem',
          'aria-label': `${row.text}: ${percent}%, ${row.count} of ${total}`,
        },
        h(
          'div',
          { class: 'bar-head' },
          h('span', { class: 'bar-label', text: row.text || '—' }),
          h(
            'span',
            { class: 'bar-value' },
            h('span', { class: 'bar-pct', text: `${percent}%` }),
            h('span', { class: 'bar-count', text: String(row.count) }),
          ),
        ),
        h(
          'div',
          { class: 'bar-track' },
          h('div', {
            class: 'bar-fill',
            style: { width: `${share * 100}%` },
            'aria-hidden': 'true',
          }),
        ),
      )
    }),
  )
}

/**
 * Text answers as a response wall.
 *
 * A true scattered word cloud sacrifices legibility for shape — rotated words,
 * arbitrary placement, size differences you cannot compare. Here identical
 * answers merge and repetition drives size *and* an explicit ×N badge, so the
 * popular answers dominate visually while every answer stays readable and every
 * count stays checkable. Reading order is frequency order.
 */
export function renderCloud(tally: TextTally): HTMLElement {
  const LIMIT = 60
  const shown = tally.entries.slice(0, LIMIT)
  const hidden = tally.entries.length - shown.length
  const max = shown[0]?.count ?? 1

  if (shown.length === 0) {
    return h('p', { class: 'empty', text: 'No answers yet.' })
  }

  return h(
    'div',
    { class: 'cloud' },
    ...shown.map((entry) => {
      // sqrt keeps area roughly proportional to count, so a 4× answer does not
      // read as 16× the ink.
      const weight = max > 1 ? Math.sqrt(entry.count / max) : 1
      const repeated = entry.count > 1

      return h(
        'span',
        {
          class: repeated ? 'chip chip--repeated' : 'chip',
          style: { fontSize: `${(0.95 + weight * 1.35).toFixed(2)}rem` },
          'aria-label': repeated ? `${entry.text}, said ${entry.count} times` : entry.text,
        },
        h('span', { class: 'chip-text', text: entry.text }),
        repeated && h('span', { class: 'chip-count', text: `×${entry.count}` }),
      )
    }),
    hidden > 0 && h('span', { class: 'chip chip--more', text: `+${hidden} more` }),
  )
}
