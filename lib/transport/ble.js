const BluetoothSwarm = require('ble-swarm')
const { TOPIC } = require('../sync.js')

// Bluetooth reaches the person standing next to you when there is no network
// at all: no wifi, no data, no DHT. bare-bluetooth only binds macOS, iOS and
// Android, and on everything else ble-swarm still loads and reports
// 'unsupported'. So this is never a reason for the app not to run, and the
// fallback to Hyperswarm costs nothing and says nothing.
//
// gatt over l2cap on purpose. l2cap is several times faster, but a check-in
// caps at 512 bytes, so there is nothing to gain and gatt behaves the same on
// every platform. Both peers must agree, and hardcoding it is how they do.
const PIPE = 'gatt'

const DEAD = new Set(['unsupported', 'unauthorized'])

// Returns null when Bluetooth is not a path on this machine. Never throws:
// every caller treats a missing radio as ordinary.
async function create ({
  keyPair,
  topic = TOPIC,
  onConnection = noop,
  onUpdate = noop,
  Swarm = BluetoothSwarm
} = {}) {
  let bt = null
  try {
    bt = new Swarm({ keyPair, topic, pipe: PIPE })
  } catch {
    return null // the module would not even construct here
  }

  if (DEAD.has(bt.state)) return null

  bt.on('connection', (connection) => onConnection(connection))
  bt.on('update', () => onUpdate(bt.state, bt.peers))
  bt.on('error', noop) // a radio that misbehaves is not worth a crash

  try {
    await bt.start()
  } catch {
    try { await bt.stop() } catch {}
    return null
  }

  // start() can resolve into a state that means no radio after all
  if (DEAD.has(bt.state)) {
    try { await bt.stop() } catch {}
    return null
  }

  return {
    get state () { return bt.state },
    get peers () { return bt.peers },

    // While the DHT is reachable, BLE is a backup and can scan lazily. With no
    // peers on the network path it is the only way out, so it hunts.
    setOnline (online) {
      try { bt.setOnline(online) } catch {}
    },

    async stop () {
      try { await bt.stop() } catch {}
    }
  }
}

function noop () {}

module.exports = { create, PIPE }
