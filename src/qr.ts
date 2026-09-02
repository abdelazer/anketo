import qrcode from 'qrcode-generator'

/**
 * Render a URL as a crisp, scalable QR SVG.
 *
 * Built as a single path of module rectangles rather than one <rect> per module
 * (a version-6 code is ~1,700 modules, and that many nodes is a visible hitch
 * on a phone). Error correction is 'M': the code goes on a projector where the
 * main risk is a shallow camera angle, not physical damage.
 */
export function qrSvg(url: string, options: { title?: string } = {}): SVGElement {
  const qr = qrcode(0, 'M')
  qr.addData(url)
  qr.make()

  const count = qr.getModuleCount()
  const margin = 2
  const size = count + margin * 2

  let path = ''
  for (let row = 0; row < count; row++) {
    // Merge horizontal runs of dark modules into one rect command.
    let run = 0
    for (let col = 0; col <= count; col++) {
      const dark = col < count && qr.isDark(row, col)
      if (dark) run++
      else if (run > 0) {
        path += `M${col - run + margin} ${row + margin}h${run}v1h-${run}z`
        run = 0
      }
    }
  }

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`)
  svg.setAttribute('class', 'qr')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', options.title ?? `QR code for ${url}`)
  svg.setAttribute('shape-rendering', 'crispEdges')

  const quiet = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  quiet.setAttribute('width', String(size))
  quiet.setAttribute('height', String(size))
  // Always white behind the modules: scanners need the light/dark polarity even
  // when the surrounding page is in dark mode.
  quiet.setAttribute('fill', '#ffffff')
  svg.appendChild(quiet)

  const modules = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  modules.setAttribute('d', path)
  modules.setAttribute('fill', '#14121a')
  svg.appendChild(modules)

  return svg
}
