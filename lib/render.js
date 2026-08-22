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
// Qualifies the second state, and never becomes a fourth one. Still only what
// this machine watched happen.
function carriedBy (reach, peers) {
  if (!reach || peers === 0) return ''
  const near = reach.bluetooth ?? 0
  if (near === 0) return ''
  if (near === peers) return dim(peers === 1 ? ', nearby over Bluetooth' : ', all nearby over Bluetooth')
  return dim(`, ${near} nearby over Bluetooth`)
}

function checkIn ({ status, peers, reach = null, gateways = 0 }) {
  const lines = []
  lines.push('')
  lines.push(bold(status === 'alert' ? paint(style.amber, 'Asking for help.') : 'You are ok.'))
  lines.push('')
  lines.push(dim('●') + ' Saved on your device')
  lines.push(dim('●') + ` Relayed to ${peers} ${plural(peers, 'peer')}` + carriedBy(reach, peers))
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

function me ({ id, profile, stats, relay, version = null }) {
  const lines = ['']
  lines.push(bold(paint(style.cyan, id)))
  if (profile) lines.push(dim(`${profile.name} · ${profile.zone}`))
  lines.push('')
  lines.push(`Carrying ${stats.total} ${plural(stats.total, 'check-in')}: ${stats.mine} yours, ${stats.others} from other people`)
  lines.push(dim(`Written by ${stats.peers} ${plural(stats.peers, 'person', 'people')}`))
  lines.push('')
  lines.push(relayLine(relay))
  if (relay && relay.alive) {
    lines.push(...reachLines(relay))
    lines.push(bluetoothLine(relay.bluetooth))
  }
  if (version) lines.push(dim('Version: ') + version)
  lines.push('')
  return lines.join('\n')
}

function relayLine (relay) {
  if (!relay || !relay.alive) return dim('Relay: ') + paint(style.amber, 'not running')
  const peers = `${relay.peers} ${plural(relay.peers, 'peer')} in range`
  return dim('Relay: ') + `running (pid ${relay.pid}), ${peers}` + (relay.uptime ? dim(`, up ${duration(relay.uptime)}`) : '')
}

// Where the peers came from. This is the whole answer to "is it working with
// the wifi off": if the network line reads zero and the bluetooth line does
// not, the offline path is carrying everything by itself.
function reachLines (relay) {
  const reach = relay?.reach
  if (!reach) return []
  const lines = []
  const near = reach.bluetooth ?? 0
  const far = reach.network ?? 0

  lines.push(
    near > 0
      ? '  ' + paint(style.cyan, String(near)) + dim(` nearby over Bluetooth, no network needed`)
      : dim(`  0 nearby over Bluetooth`)
  )
  lines.push(
    far > 0
      ? '  ' + String(far) + dim(' over the network')
      : dim('  0 over the network') + (near > 0 ? dim(' — nothing but Bluetooth right now') : '')
  )
  return lines
}

// What Bluetooth is doing, in the words the radio itself reports. Only ever
// shown in the diagnostic views: a peer reached over BLE is a peer, and the
// check-in makes the same claim about it as about any other.
function bluetoothLine (bluetooth) {
  if (!bluetooth || bluetooth.state === 'unsupported') {
    return dim('Bluetooth: ') + dim('not available on this machine')
  }
  if (bluetooth.state === 'unauthorized') {
    return dim('Bluetooth: ') + paint(style.amber, 'not permitted') +
      dim(' — allow it in System Settings › Privacy › Bluetooth')
  }
  if (bluetooth.state === 'off') return dim('Bluetooth: ') + paint(style.amber, 'off')
  if (bluetooth.state === 'on') {
    const peers = bluetooth.peers ?? 0
    return dim('Bluetooth: ') + `on, ${peers} ${plural(peers, 'peer')} nearby` +
      (peers === 0 ? dim(' — works with the wifi off') : '')
  }
  return dim('Bluetooth: ') + bluetooth.state
}

// attempted says we just tried to start one and it did not come up, so the
// usual "run imok and it starts on its own" would be a lie.
function relayReport (relay, { attempted = false } = {}) {
  const lines = ['', relayLine(relay)]
  if (relay && relay.alive) {
    lines.push(...reachLines(relay))
    lines.push(bluetoothLine(relay.bluetooth))
  }
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

// The live view. A full repaint each time, because the block is a dozen lines
// and diffing it would be more code than it saves.
function watch (relay, { now = Date.now(), started = now, columns = DEFAULT_COLUMNS } = {}) {
  const width = clampColumns(columns)
  const lines = ['']

  if (!relay || relay.alive !== true) {
    lines.push(paint(style.amber, 'No relay running.'))
    lines.push('')
    lines.push(dim('  Nothing is carrying check-ins. Run ' + bold('imok') + dim(' in another')))
    lines.push(dim('  terminal and this picks it up on its own.'))
    lines.push('')
    lines.push(dim(rule(width)))
    lines.push(dim(`watching · ${duration(now - started)}` + '   ctrl+c to stop'))
    return lines.join('\n')
  }

  const reach = relay.reach ?? { network: 0, bluetooth: 0 }
  const near = reach.bluetooth ?? 0
  const far = reach.network ?? 0

  lines.push(bold(`${relay.peers} ${plural(relay.peers, 'peer')} in range`))
  lines.push('')
  lines.push(meter('Bluetooth', near, width) + dim('  no network needed'))
  lines.push(meter('Network', far, width))
  lines.push('')
  lines.push(bluetoothLine(relay.bluetooth))
  lines.push(dim('Relay: ') + `pid ${relay.pid}` + dim(`, up ${duration(relay.uptime ?? 0)}`))
  lines.push('')

  if (near > 0 && far === 0) {
    lines.push(paint(style.cyan, '  Everything you are carrying arrived over Bluetooth.'))
    lines.push(dim('  There is no network path right now and it did not need one.'))
  } else if (near === 0 && far === 0) {
    lines.push(dim('  Nobody in range yet, on either path. Both keep looking.'))
  }

  lines.push('')
  lines.push(dim(rule(width)))
  lines.push(dim(`watching · ${duration(now - started)}` + '   ctrl+c to stop'))
  return lines.join('\n')
}

// A count as a row of blocks, so a peer appearing is visible from across a room.
// The bar saturates; the number never does. Truncating a count would show a
// number that is not the count, which is worse than a wider line.
function meter (label, count, width) {
  const room = Math.max(4, Math.min(24, width - 24))
  const filled = Math.min(count, room)
  const blocks = '█'.repeat(filled)
  const rest = dim('·'.repeat(Math.max(0, room - filled)))
  const bar = (count > 0 ? paint(style.cyan, blocks) : blocks) + rest
  const shown = String(count)
  return pad(label, 10) + ' ' + bar + ' ' + ' '.repeat(Math.max(0, 3 - shown.length)) + shown
}

function rule (width) {
  return '─'.repeat(Math.max(0, width - 1))
}

// Clears the screen and puts the cursor home, so a repaint lands on top of the
// last one instead of scrolling it away.
const CLEAR = ESC + '2J' + ESC + 'H'
const HIDE_CURSOR = ESC + '?25l'
const SHOW_CURSOR = ESC + '?25h'

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
  bluetoothLine,
  reachLines,
  carriedBy,
  watch,
  meter,
  CLEAR,
  HIDE_CURSOR,
  SHOW_CURSOR,
  ago,
  duration
}
