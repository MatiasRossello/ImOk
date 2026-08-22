// Plain ANSI, built by hand. Everything here is a pure function of its
// arguments so the layout can be tested at any width without a terminal.

const MIN_COLUMNS = 60
const DEFAULT_COLUMNS = 80

const ESC = '\x1b['
const style = {
  reset: ESC + '0m',
  dim: ESC + '2m',
  bold: ESC + '1m',
  amber: ESC + '33m',
  cyan: ESC + '36m'
}

let colour = true
function setColour (on) {
  colour = on
}

function paint (code, text) {
  return colour ? code + text + style.reset : text
}

const dim = (t) => paint(style.dim, t)
const bold = (t) => paint(style.bold, t)

// ---------------------------------------------------------------- widths

// Good enough for names and notes: combining marks and variation selectors
// take no room, CJK and emoji take two columns, everything else takes one.
// ponytail: no full wcwidth table, and a ZWJ family emoji over-counts;
// swap in a real table if anyone ever complains
function displayWidth (text) {
  let total = 0
  for (const character of text) {
    const point = character.codePointAt(0)
    if (isZeroWidth(point)) continue
    total += isWide(point) ? 2 : 1
  }
  return total
}

function isZeroWidth (point) {
  return (
    (point >= 0x0300 && point <= 0x036f) || // combining diacritics
    (point >= 0x200b && point <= 0x200f) || // zero width and direction marks
    point === 0xfe0e ||
    point === 0xfe0f || // variation selectors
    (point >= 0x1f3fb && point <= 0x1f3ff) // skin tone modifiers
  )
}

function isWide (point) {
  return (
    (point >= 0x1100 && point <= 0x115f) ||
    (point >= 0x2e80 && point <= 0xa4cf) ||
    (point >= 0xac00 && point <= 0xd7a3) ||
    (point >= 0xf900 && point <= 0xfaff) ||
    (point >= 0xfe30 && point <= 0xfe6f) ||
    (point >= 0xff00 && point <= 0xff60) ||
    (point >= 0xffe0 && point <= 0xffe6) ||
    (point >= 0x1f300 && point <= 0x1f64f) ||
    (point >= 0x1f680 && point <= 0x1f6ff) ||
    (point >= 0x1f900 && point <= 0x1f9ff)
  )
}

function truncate (text, limit) {
  if (displayWidth(text) <= limit) return text
  if (limit <= 1) return '…'.slice(0, limit)
  let out = ''
  let used = 0
  for (const character of text) {
    const step = isZeroWidth(character.codePointAt(0)) ? 0 : isWide(character.codePointAt(0)) ? 2 : 1
    if (used + step > limit - 1) break
    out += character
    used += step
  }
  return out + '…'
}

function pad (text, limit) {
  const clipped = truncate(text, limit)
  return clipped + ' '.repeat(Math.max(0, limit - displayWidth(clipped)))
}

function clampColumns (columns) {
  if (!Number.isInteger(columns) || columns <= 0) return DEFAULT_COLUMNS
  return Math.max(MIN_COLUMNS, columns)
}

// ---------------------------------------------------------------- views

// The only three claims this program makes, in the only wording it uses.
// Every one of them is something the local machine can check for itself.
function checkIn ({ status, peers, gateways = 0 }) {
  const lines = []
  lines.push('')
  lines.push(bold(status === 'alert' ? paint(style.amber, 'Asking for help.') : 'You are ok.'))
  lines.push('')
  lines.push(dim('●') + ' Saved on your device')
  lines.push(dim('●') + ` Relayed to ${peers} ${plural(peers, 'peer')}`)
  if (gateways > 0) {
    lines.push(dim('●') + ` Reached the internet via ${gateways} ${plural(gateways, 'gateway')}`)
  }
  if (peers === 0) {
    lines.push('')
    lines.push(dim('  No peers in range yet. Your relay keeps looking, and this'))
    lines.push(dim('  goes out the moment one turns up. Nothing was thrown away.'))
  }
  lines.push('')
  return lines.join('\n')
}

function roster (messages, { columns = DEFAULT_COLUMNS, now = Date.now(), query = null, peers = 0 } = {}) {
  const width = clampColumns(columns)

  if (messages.length === 0) return emptyRoster({ query, peers })

  // name, status, when, then zone and note share whatever is left
  const nameWidth = Math.min(18, Math.max(10, Math.floor(width * 0.22)))
  const statusWidth = 6
  const whenWidth = 9
  const fixed = nameWidth + statusWidth + whenWidth + 3
  let zoneWidth = Math.min(14, Math.floor((width - fixed) * 0.4))
  if (width - fixed - zoneWidth - 1 < 8) zoneWidth = 0 // narrow terminal: drop the zone
  const noteWidth = Math.max(0, width - fixed - (zoneWidth === 0 ? 0 : zoneWidth + 1))

  const header = [
    pad('WHO', nameWidth),
    pad('STATE', statusWidth),
    pad('WHEN', whenWidth),
    zoneWidth === 0 ? null : pad('ZONE', zoneWidth),
    pad('NOTE', noteWidth)
  ].filter((cell) => cell !== null).join(' ').trimEnd()

  const rows = messages.map((message) => {
    const state = message.status === 'alert' ? paint(style.amber, pad('alert', statusWidth)) : dim(pad('ok', statusWidth))
    return [
      pad(message.name, nameWidth),
      state,
      dim(pad(ago(message.ts, now), whenWidth)),
      zoneWidth === 0 ? null : dim(pad(message.zone, zoneWidth)),
      pad(message.note, noteWidth)
    ].filter((cell) => cell !== null).join(' ').trimEnd()
  })

  return ['', dim(header), ...rows, '', dim(footer(messages.length, peers)), ''].join('\n')
}

function emptyRoster ({ query, peers }) {
  if (query) {
    return [
      '',
      `Nobody matching ${bold(query)} in what this device is carrying.`,
      '',
      dim('  The roster only holds what has reached you. Somebody can be'),
      dim('  perfectly fine and not be here yet.'),
      dim('  Try ' + bold('imok list') + dim(' with no filter to see everything you have.')),
      ''
    ].join('\n')
  }
  if (peers === 0) {
    return [
      '',
      'Nothing here yet, and no peers in range.',
      '',
      dim('  Your relay is looking for other devices. As soon as one turns'),
      dim('  up you will start carrying their check-ins, and they yours.'),
      dim('  Leave it running and try ' + bold('imok list') + dim(' again in a minute.')),
      ''
    ].join('\n')
  }
  return [
    '',
    `Nothing here yet, though you are talking to ${peers} ${plural(peers, 'peer')}.`,
    '',
    dim('  Nobody has checked in recently. Run ' + bold('imok') + dim(' to add yours.')),
    ''
  ].join('\n')
}

function footer (count, peers) {
  return `${count} ${plural(count, 'check-in')} · carried for ${peers} ${plural(peers, 'peer')} in range`
}

function me ({ id, profile, stats, relay }) {
  const lines = ['']
  lines.push(bold(paint(style.cyan, id)))
  if (profile) lines.push(dim(`${profile.name} · ${profile.zone}`))
  lines.push('')
  lines.push(`Carrying ${stats.total} ${plural(stats.total, 'check-in')}: ${stats.mine} yours, ${stats.others} from other people`)
  lines.push(dim(`Written by ${stats.peers} ${plural(stats.peers, 'person', 'people')}`))
  lines.push('')
  lines.push(relayLine(relay))
  lines.push('')
  return lines.join('\n')
}

function relayLine (relay) {
  if (!relay || !relay.alive) return dim('Relay: ') + paint(style.amber, 'not running')
  const peers = `${relay.peers} ${plural(relay.peers, 'peer')} in range`
  return dim('Relay: ') + `running (pid ${relay.pid}), ${peers}` + (relay.uptime ? dim(`, up ${duration(relay.uptime)}`) : '')
}

// attempted says we just tried to start one and it did not come up, so the
// usual "run imok and it starts on its own" would be a lie.
function relayReport (relay, { attempted = false } = {}) {
  const lines = ['', relayLine(relay)]
  if (!relay || !relay.alive) {
    lines.push('')
    if (attempted) {
      lines.push(dim('  It would not start just now, so nothing is carrying your'))
      lines.push(dim('  check-in yet. It is on disk and goes out on the next run.'))
      lines.push(dim('  See ' + bold('relay.log') + dim(' in your storage directory for why.')))
    } else {
      lines.push(dim('  Nothing is carrying your check-ins right now, and nothing is'))
      lines.push(dim('  picking up other people\'s. Run ' + bold('imok') + dim(' and it starts on its own.')))
    }
  }
  lines.push('')
  return lines.join('\n')
}

// A relay is holding the message store but not answering on its socket. The
// command did nothing at all, and saying so is the only honest option.
function relayStuck (relay) {
  const who = relay && relay.pid ? ` (pid ${relay.pid})` : ''
  return [
    '',
    dim('Relay: ') + paint(style.amber, 'not answering') + dim(who),
    '',
    dim('  Something is holding your message store without responding, so'),
    dim('  nothing could be read or written just now. Nothing was lost.'),
    dim('  Run ' + bold('imok relay --stop') + dim(' to clear it, then try again.')),
    ''
  ].join('\n')
}

// ---------------------------------------------------------------- bits

function ago (ts, now) {
  const seconds = Math.max(0, Math.floor((now - ts) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return minutes + 'm ago'
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + 'h ago'
  return Math.floor(hours / 24) + 'd ago'
}

function duration (ms) {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return seconds + 's'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return minutes + 'm'
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + 'h'
  return Math.floor(hours / 24) + 'd'
}

function plural (n, one, many = one + 's') {
  return n === 1 ? one : many
}

module.exports = {
  MIN_COLUMNS,
  DEFAULT_COLUMNS,
  setColour,
  displayWidth,
  truncate,
  pad,
  clampColumns,
  checkIn,
  roster,
  me,
  relayReport,
  relayStuck,
  relayLine,
  ago,
  duration
}
