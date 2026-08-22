const { test } = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const crypto = require('hypercore-crypto')

const render = require('../lib/render.js')
const { create } = require('../lib/message.js')

render.setColour(false)

const identity = crypto.keyPair()
const now = Date.now()

function rows (specs) {
  return specs.map(([name, status, note, zone], i) =>
    create({ name, status, note, zone }, identity, now - i * 60000))
}

const sample = rows([
  ['José Ramírez', 'ok', 'todo tranquilo por acá', 'Villa Crespo'],
  ['🚑 Ana', 'alert', 'necesito ayuda urgente en la esquina', 'Palermo Soho'],
  ['한국어이름테스트', 'ok', 'wide characters', 'Seoul'],
  ['Bo', 'ok', 'ok', 'z']
])

test('displayWidth counts columns, not code units', (t) => {
  t.is(render.displayWidth('hello'), 5, 'ascii')
  t.is(render.displayWidth('José'), 4, 'precomposed accent is one column')
  t.is(render.displayWidth('café'), 4, 'combining accent takes no column')
  t.is(render.displayWidth('🚑'), 2, 'emoji is two columns')
  t.is(render.displayWidth('한국'), 4, 'cjk is two columns each')
  t.is(render.displayWidth(''), 0)
})

test('truncate never exceeds the budget', (t) => {
  for (const text of ['hello world', '🚑🚑🚑🚑🚑', '한국어이름테스트', 'José Ramírez']) {
    for (let limit = 1; limit <= 12; limit++) {
      const out = render.truncate(text, limit)
      t.ok(render.displayWidth(out) <= limit, `"${text}" at ${limit} -> width ${render.displayWidth(out)}`)
    }
  }
})

test('pad fills to exactly the requested width', (t) => {
  for (const text of ['ab', '🚑', 'José', '한국어']) {
    t.is(render.displayWidth(render.pad(text, 10)), 10, text)
  }
})

test('a terminal narrower than the minimum is treated as the minimum', (t) => {
  t.is(render.clampColumns(20), render.MIN_COLUMNS)
  t.is(render.clampColumns(0), render.DEFAULT_COLUMNS)
  t.is(render.clampColumns(undefined), render.DEFAULT_COLUMNS)
  t.is(render.clampColumns(200), 200)
})

test('the roster fits the terminal at every width', (t) => {
  for (const columns of [60, 72, 80, 120, 200]) {
    const out = render.roster(sample, { columns, now, peers: 2 })
    const widest = Math.max(...out.split('\n').map((line) => render.displayWidth(line)))
    t.ok(widest <= columns, `${columns} columns -> widest line ${widest}`)
  }
})

test('a narrow terminal drops the zone rather than overflowing', (t) => {
  const narrow = render.roster(sample, { columns: 60, now, peers: 1 })
  const wide = render.roster(sample, { columns: 120, now, peers: 1 })
  t.ok(wide.includes('ZONE'), 'zone shown when there is room')
  t.ok(Math.max(...narrow.split('\n').map((l) => render.displayWidth(l))) <= 60)
})

test('an empty roster explains itself instead of printing nothing', (t) => {
  const noPeers = render.roster([], { peers: 0 })
  t.ok(noPeers.trim().length > 40, 'says something substantial')
  t.ok(/looking|turns up/i.test(noPeers), 'explains what is happening')
  t.ok(/imok list/.test(noPeers), 'suggests an action')

  const withPeers = render.roster([], { peers: 3 })
  t.ok(/3 peers/.test(withPeers), 'mentions the peers it does have')
  t.ok(/imok/.test(withPeers), 'suggests an action')

  const noMatch = render.roster([], { query: 'zzz', peers: 2 })
  t.ok(/zzz/.test(noMatch), 'repeats what was searched for')
  t.ok(/only holds what has reached you/i.test(noMatch), 'explains why it may be missing')
})

test('the three states are worded exactly one way', (t) => {
  const out = render.checkIn({ status: 'ok', peers: 3, gateways: 2 })
  t.ok(out.includes('● Saved on your device'))
  t.ok(out.includes('● Relayed to 3 peers'))
  t.ok(out.includes('● Reached the internet via 2 gateways'))

  const alone = render.checkIn({ status: 'ok', peers: 0 })
  t.ok(alone.includes('● Relayed to 0 peers'), 'zero is stated plainly')
  t.absent(alone.includes('gateway'), 'no gateway claim without a gateway')
  t.ok(/Nothing was thrown away/.test(alone), 'and it explains what that means')

  t.ok(render.checkIn({ status: 'ok', peers: 1 }).includes('1 peer'), 'singular')
})

test('the banner fits the narrowest terminal the app promises to support', (t) => {
  for (const status of ['ok', 'alert']) {
    const out = render.checkIn({ status, peers: 2 })
    const widest = Math.max(...out.split('\n').map((line) => render.displayWidth(line)))
    t.ok(widest <= render.MIN_COLUMNS, `${status} banner -> widest line ${widest}`)
  }
})

test('a check-in speaks in the first person', (t) => {
  t.ok(render.checkIn({ status: 'ok', peers: 1 }).includes("I'm ok."))
  t.ok(render.checkIn({ status: 'alert', peers: 1 }).includes('I need help.'))
})

test('the state column reads at a glance without widening', (t) => {
  const out = render.roster(sample, { columns: 80, now, peers: 2 })
  t.ok(out.includes('▲ help'), 'the urgent one carries a mark of its own')
  t.ok(out.includes('● ok'), 'and the ordinary one the same bullet as the check-in')
})

test('nothing claims the message reached a person', (t) => {
  const outputs = [
    render.checkIn({ status: 'ok', peers: 0 }),
    render.checkIn({ status: 'alert', peers: 5, gateways: 1 }),
    render.roster(sample, { columns: 80, now, peers: 2 }),
    render.roster([], { peers: 0 }),
    render.roster([], { query: 'x', peers: 1 }),
    render.me({ id: 'ABCD2345', profile: { name: 'Ana', zone: 'z' }, stats: { total: 2, mine: 1, others: 1, peers: 2 }, relay: { alive: true, pid: 1, peers: 2, uptime: 60000 } }),
    render.relayReport({ alive: false })
  ].join('\n')

  for (const banned of [/\bdelivered\b/i, /\bsent\b/i, /\breceived by\b/i, /✓/, /\bdelivery\b/i]) {
    t.absent(banned.test(outputs), 'no match for ' + banned)
  }
})

test('the relay report distinguishes never started from would not start', (t) => {
  const idle = render.relayReport({ alive: false })
  t.ok(idle.includes('not running'))
  t.ok(idle.includes('starts on its own'), 'tells you how to get one')

  const failed = render.relayReport({ alive: false }, { attempted: true })
  t.ok(failed.includes('would not start'), 'does not claim it will start on its own')
  t.ok(failed.includes('relay.log'), 'points at where the reason is')
  t.ok(failed.includes('goes out on the next run'), 'says the check-in survived')

  const up = render.relayReport({ alive: true, pid: 42, peers: 2, uptime: 61000 })
  t.ok(up.includes('running (pid 42)'))
  t.ok(up.includes('2 peers in range'))
  t.absent(up.includes('starts on its own'), 'no advice when there is nothing to fix')
})

test('a relay that holds the store without answering is reported, not papered over', (t) => {
  const stuck = render.relayStuck({ alive: true, pid: 7, peers: 0, uptime: 0 })
  t.ok(stuck.includes('not answering'))
  t.ok(stuck.includes('pid 7'))
  t.ok(stuck.includes('Nothing was lost'), 'says what happened to the check-in')
  t.ok(stuck.includes('imok relay --stop'), 'gives a way out')
})

// lib has subdirectories now, and a transport is exactly the kind of file
// that grows a "sent" in a log line.
function sources (dir) {
  const out = []
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (fs.statSync(full).isDirectory()) out.push(...sources(full))
    else if (full.endsWith('.js')) out.push(full)
  }
  return out
}

test('no interface string in the source promises delivery', (t) => {
  const root = path.join(__dirname, '..')
  const files = ['bin.mjs', ...sources(path.join(root, 'lib')).map((f) => path.relative(root, f))]
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8')
    for (const banned of [/\bdelivered\b/i, /\bsent\b/i, /\breceived by\b/i, /✓/]) {
      t.absent(banned.test(source), `${file} has no ${banned}`)
    }
  }
})

test('relative times read the way a person would say them', (t) => {
  t.is(render.ago(now, now), 'just now')
  t.is(render.ago(now - 90 * 1000, now), '1m ago')
  t.is(render.ago(now - 3 * 3600 * 1000, now), '3h ago')
  t.is(render.ago(now - 50 * 3600 * 1000, now), '2d ago')
  t.is(render.ago(now + 5000, now), 'just now', 'a clock slightly ahead does not read as the future')
})

test('the roster caps the rows without lying about the total', (t) => {
  const now = 1700000000000
  const many = []
  for (let i = 0; i < 25; i++) {
    many.push({ v: 1, name: 'peer' + i, status: 'ok', note: 'n', zone: 'z', ts: now - i * 1000, pk: 'a', sig: 'b' })
  }

  const capped = render.roster(many, { columns: 80, now, peers: 2 })
  // anchored: the footer says "carried for 2 peers" and would count as a row
  const rows = capped.split('\n').filter((line) => /^peer\d/.test(line))
  t.is(rows.length, render.DEFAULT_LIMIT, 'draws only the default number of rows')
  t.ok(capped.includes('peer0'), 'keeps the newest')
  t.absent(capped.includes('peer24'), 'drops the oldest')
  t.ok(capped.includes('last 10 of 25 check-ins'), 'the footer counts everything held, not what was drawn')

  const all = render.roster(many, { columns: 80, now, peers: 2, limit: null })
  t.is(all.split('\n').filter((line) => /^peer\d/.test(line)).length, 25, 'limit null draws them all')
  t.ok(all.includes('25 check-ins'), 'and says so plainly')
  t.absent(all.includes('last 25 of'), 'without claiming anything was hidden')

  const under = render.roster(many.slice(0, 3), { columns: 80, now, peers: 1 })
  t.ok(under.includes('3 check-ins'), 'a roster under the cap is not described as truncated')
  t.absent(under.includes('last 3 of'), '')
})
