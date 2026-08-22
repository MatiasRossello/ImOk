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
