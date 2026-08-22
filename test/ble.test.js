const { test } = require('brittle')
const EventEmitter = require('bare-events')
const crypto = require('hypercore-crypto')

const ble = require('../lib/transport/ble.js')
const render = require('../lib/render.js')

render.setColour(false)

// A radio we can drive. The real one needs two machines in the same room, so
// what is testable here is every path around it: refusing to start, coming up,
// handing connections on, and going quiet when it is not there.
class FakeRadio extends EventEmitter {
  constructor ({ state = 'off', becomes = 'on', failStart = false, throwOnNew = false } = {}) {
    super()
    if (throwOnNew) throw new Error('no bluetooth stack')
    this.state = state
    this.becomes = becomes
    this.failStart = failStart
    this.peers = 0
    this.started = false
    this.stopped = false
    this.online = null
  }

  async start () {
    if (this.failStart) throw new Error('radio busy')
    this.started = true
    this.state = this.becomes
    this.emit('update')
  }

  async stop () {
    this.stopped = true
    this.state = 'off'
  }

  setOnline (online) { this.online = online }

  arrive (connection) {
    this.peers++
    this.emit('connection', connection)
  }
}

function factory (opts) {
  let made = null
  const Swarm = class {
    constructor (config) {
      made = new FakeRadio(opts)
      made.config = config
      return made
    }
  }
  return { Swarm, radio: () => made }
}

const keyPair = crypto.keyPair()

test('an unsupported platform gets null, not an exception', async (t) => {
  const { Swarm } = factory({ state: 'unsupported' })
  t.is(await ble.create({ keyPair, Swarm }), null, 'no transport')
})

test('a machine that refuses permission gets null too', async (t) => {
  const { Swarm } = factory({ state: 'unauthorized' })
  t.is(await ble.create({ keyPair, Swarm }), null)
})

test('a module that will not even construct gets null', async (t) => {
  const { Swarm } = factory({ throwOnNew: true })
  t.is(await ble.create({ keyPair, Swarm }), null, 'swallowed the constructor throw')
})

test('a radio that fails to start is stopped and reported as absent', async (t) => {
  const { Swarm, radio } = factory({ failStart: true })
  t.is(await ble.create({ keyPair, Swarm }), null)
  t.is(radio().stopped, true, 'did not leave the radio half up')
})

test('a radio that starts into unsupported is still null', async (t) => {
  const { Swarm, radio } = factory({ state: 'off', becomes: 'unsupported' })
  t.is(await ble.create({ keyPair, Swarm }), null, 'start() can reveal there is no radio')
  t.is(radio().stopped, true)
})

test('a working radio hands its connections on and reports itself', async (t) => {
  const { Swarm, radio } = factory({})
  const seen = []
  const updates = []

  const transport = await ble.create({
    keyPair,
    onConnection: (c) => seen.push(c),
    onUpdate: (state, peers) => updates.push([state, peers]),
    Swarm
  })
  t.teardown(() => transport.stop())

  t.not(transport, null, 'came up')
  t.is(transport.state, 'on')
  t.is(transport.peers, 0)
  t.alike(updates.at(-1), ['on', 0], 'reported coming up')

  const connection = { fake: true }
  radio().arrive(connection)
  t.is(seen.length, 1, 'the connection was handed on')
  t.is(seen[0], connection, 'unwrapped, so it plugs into sync like any socket')
  t.is(transport.peers, 1)
})

test('both peers pick the same pipe, or they would refuse each other', async (t) => {
  const { Swarm, radio } = factory({})
  const transport = await ble.create({ keyPair, Swarm })
  t.teardown(() => transport.stop())
  t.is(radio().config.pipe, ble.PIPE)
  t.is(ble.PIPE, 'gatt', 'the one that behaves the same everywhere')
})

test('the online hint is passed through and never throws', async (t) => {
  const { Swarm, radio } = factory({})
  const transport = await ble.create({ keyPair, Swarm })
  t.teardown(() => transport.stop())

  transport.setOnline(true)
  t.is(radio().online, true, 'scan lazily while the network path has company')
  transport.setOnline(false)
  t.is(radio().online, false, 'hunt when it is the only way out')

  radio().setOnline = () => { throw new Error('radio gone') }
  transport.setOnline(true)
  t.pass('a radio that vanishes mid-hint does not take the relay with it')
})

test('the bluetooth line says what the radio says, and nothing more', (t) => {
  t.ok(render.bluetoothLine(null).includes('not available'))
  t.ok(render.bluetoothLine({ state: 'unsupported' }).includes('not available'))
  t.ok(render.bluetoothLine({ state: 'unauthorized' }).includes('not permitted'))
  t.ok(render.bluetoothLine({ state: 'unauthorized' }).includes('System Settings'), 'says how to fix it')
  t.ok(render.bluetoothLine({ state: 'off' }).includes('off'))

  const alone = render.bluetoothLine({ state: 'on', peers: 0 })
  t.ok(alone.includes('0 peers nearby'))
  t.ok(alone.includes('works with the wifi off'), 'explains why it is worth having')

  const company = render.bluetoothLine({ state: 'on', peers: 2 })
  t.ok(company.includes('2 peers nearby'))
  t.absent(company.includes('wifi off'), 'no advice once it is doing its job')
})

// ------------------------------------------------- seeing it work with no wifi

const UP = { alive: true, pid: 42, uptime: 61000, bluetooth: { state: 'on', peers: 1 } }

test('the reach breakdown says which radio carried each peer', (t) => {
  const offline = render.reachLines({ ...UP, peers: 2, reach: { network: 0, bluetooth: 2 } }).join('\n')
  t.ok(offline.includes('2 nearby over Bluetooth'))
  t.ok(offline.includes('no network needed'))
  t.ok(offline.includes('nothing but Bluetooth right now'), 'names the offline case outright')

  const mixed = render.reachLines({ ...UP, peers: 3, reach: { network: 2, bluetooth: 1 } }).join('\n')
  t.ok(mixed.includes('1 nearby over Bluetooth'))
  t.ok(mixed.includes('2 over the network'))
  t.absent(mixed.includes('nothing but Bluetooth'), 'not the offline case')

  t.alike(render.reachLines({ ...UP, peers: 0 }), [], 'a relay too old to report reach says nothing')
})

test('the check-in qualifies its peer count without growing a fourth state', (t) => {
  const bullets = (out) => out.split('\n').filter((l) => l.startsWith('●')).length

  const offline = render.checkIn({ status: 'ok', peers: 2, reach: { network: 0, bluetooth: 2 } })
  t.ok(offline.includes('Relayed to 2 peers, all nearby over Bluetooth'))
  t.is(bullets(offline), 2, 'still Saved and Relayed, nothing else')

  const one = render.checkIn({ status: 'ok', peers: 1, reach: { network: 0, bluetooth: 1 } })
  t.ok(one.includes('Relayed to 1 peer, nearby over Bluetooth'))

  const mixed = render.checkIn({ status: 'ok', peers: 3, reach: { network: 2, bluetooth: 1 } })
  t.ok(mixed.includes('Relayed to 3 peers, 1 nearby over Bluetooth'))

  const wired = render.checkIn({ status: 'ok', peers: 2, reach: { network: 2, bluetooth: 0 } })
  t.ok(wired.includes('Relayed to 2 peers'))
  t.absent(wired.includes('Bluetooth'), 'no bluetooth noise when it carried nothing')

  const old = render.checkIn({ status: 'ok', peers: 2 })
  t.ok(old.includes('Relayed to 2 peers'), 'no reach at all is still a valid check-in')
})

test('the live view calls the offline case by its name', (t) => {
  const offline = render.watch({ ...UP, peers: 1, reach: { network: 0, bluetooth: 1 } }, { columns: 72 })
  t.ok(offline.includes('1 peer in range'))
  t.ok(offline.includes('Everything you are carrying arrived over Bluetooth'))
  t.ok(offline.includes('did not need one'))
  t.ok(offline.includes('ctrl+c to stop'))

  const empty = render.watch({ ...UP, peers: 0, reach: { network: 0, bluetooth: 0 } }, { columns: 72 })
  t.ok(empty.includes('Nobody in range yet, on either path'))
  t.absent(empty.includes('arrived over Bluetooth'), 'claims nothing with nobody around')

  const mixed = render.watch({ ...UP, peers: 3, reach: { network: 2, bluetooth: 1 } }, { columns: 72 })
  t.absent(mixed.includes('Everything you are carrying'), 'not everything came over BLE')

  const down = render.watch({ alive: false }, { columns: 72 })
  t.ok(down.includes('No relay running'))
  t.ok(down.includes('ctrl+c to stop'), 'the footer survives the empty case')
})

test('the live view fits whatever terminal it is given', (t) => {
  for (const columns of [60, 80, 200]) {
    const out = render.watch({ ...UP, peers: 40, reach: { network: 20, bluetooth: 20 } }, { columns })
    const widest = Math.max(...out.split('\n').map((l) => render.displayWidth(l)))
    t.ok(widest <= Math.max(columns, render.MIN_COLUMNS), `fits at ${columns} (widest ${widest})`)
  }
})

test('the meter saturates instead of running off the line', (t) => {
  const huge = render.meter('Bluetooth', 9999, 80)
  t.ok(render.displayWidth(huge) <= 80, 'a busy relay does not wrap')
  t.ok(huge.includes('9999'), 'the real count is still shown')
})
