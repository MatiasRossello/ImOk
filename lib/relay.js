const fs = require('bare-fs')
const fsx = require('fs-native-extensions')
const path = require('bare-path')
const process = require('bare-process')
const daemon = require('bare-daemon')
const Hyperswarm = require('hyperswarm')
const hypercrypto = require('hypercore-crypto')
const ipc = require('./ipc.js')
const { attach, TOPIC } = require('./sync.js')
const ble = require('./transport/ble.js')
const { loadIdentity } = require('./identity.js')
const { open: openStore } = require('./store.js')
const { create } = require('./message.js')
const { loadProfile } = require('./profile.js')

const LOCK = 'relay.lock'
const STATE = 'relay.json'
const PURGE_INTERVAL = 60 * 60 * 1000 // the TTL is 72 h, so hourly is plenty
const SHUTDOWN_GRACE = 5000 // longest a stop is allowed to take before we just go

// Liveness comes from an advisory lock, not from a pid in a file: if the relay
// is killed with -9 the OS drops the lock for us, so a stale file can never be
// mistaken for a running relay. A machine reboot is the same case, which is
// why a relay never comes back as a zombie.
function relayStatus (dir) {
  const down = { alive: false, pid: null, peers: 0, uptime: 0 }
  let handle = null
  try {
    handle = fs.openSync(path.join(dir, LOCK), 'a+')
  } catch {
    return down
  }

  try {
    if (fsx.tryLock(handle)) {
      fsx.unlock(handle) // we got it, so nobody is holding it
      return down
    }
  } catch {
    return down
  } finally {
    try { fs.closeSync(handle) } catch {}
  }

  try {
    const state = JSON.parse(fs.readFileSync(path.join(dir, STATE), 'utf8'))
    return {
      alive: true,
      pid: state.pid ?? null,
      peers: state.peers ?? 0,
      bluetooth: state.bluetooth ?? null,
      uptime: state.startedAt ? Date.now() - state.startedAt : 0
    }
  } catch {
    return { alive: true, pid: null, peers: 0, uptime: 0 }
  }
}

// Held for as long as the relay runs. Returns null if another relay has it.
function holdLock (dir) {
  fs.mkdirSync(dir, { recursive: true })
  const handle = fs.openSync(path.join(dir, LOCK), 'a+')
  let held = false
  try {
    held = fsx.tryLock(handle) !== false
  } catch {
    held = false // fs-native-extensions throws rather than returning false
  }
  if (held) return handle
  fs.closeSync(handle)
  return null
}

function releaseLock (handle) {
  if (handle === null) return
  try { fsx.unlock(handle) } catch {}
  try { fs.closeSync(handle) } catch {}
}

function writeState (dir, state) {
  try {
    fs.writeFileSync(path.join(dir, STATE), JSON.stringify(state))
  } catch {
    // the state file is a convenience, never a reason to fall over
  }
}

// ---------------------------------------------------------- daemon lifecycle

// Starts a relay if none is running, and does nothing if one already is. Waits
// until it answers on its socket, so the caller reports what is true rather
// than what it hopes. Never throws: a relay that will not start is a state the
// commands know how to describe.
async function ensureRelay (dir, opts = {}) {
  const { execPath = null, entrypoint = null, timeout = 2500, args: extra = [] } = opts

  const current = relayStatus(dir)
  if (current.alive) {
    const live = await ipc.request(dir, { t: 'ping' }, { timeout: 800 })
    return { ...describe(live, current), alreadyRunning: true }
  }
  if (execPath === null) return { ...dead(), alreadyRunning: false }

  const args = entrypoint === null ? [] : [entrypoint]
  args.push('relay', '--foreground', '--detached', '--no-updates', '--storage', dir, ...extra)

  let pid = null
  try {
    pid = daemon.spawn(execPath, args).pid
  } catch {
    return { ...dead(), alreadyRunning: false }
  }

  const live = await waitForRelay(dir, timeout)
  if (live === null) return { ...dead(), pid, alreadyRunning: false }
  return { ...describe(live, null), alreadyRunning: false }
}

function dead () {
  return { alive: false, pid: null, peers: 0, uptime: 0 }
}

function describe (reply, fallback) {
  if (reply === null || reply.ok !== true) return fallback ?? dead()
  return {
    alive: true,
    pid: reply.pid ?? null,
    peers: reply.peers ?? 0,
    bluetooth: reply.bluetooth ?? null,
    uptime: reply.uptime ?? 0
  }
}

async function waitForRelay (dir, timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const reply = await ipc.request(dir, { t: 'ping' }, { timeout: 400 })
    if (reply !== null && reply.ok === true) return reply
    await sleep(50)
  }
  return null
}

// The lock and the state file are enough to know whether a relay is up, but a
// running relay knows its own peer count better than a file does.
async function liveStatus (dir) {
  const status = relayStatus(dir)
  if (status.alive === false) return status
  const reply = await ipc.request(dir, { t: 'ping' }, { timeout: 1500 })
  return describe(reply, status)
}

// Waits for the lock to actually come free, not just for the relay to say it
// heard us. Otherwise the obvious next command lands while the store is still
// held and has to report a relay that is not answering.
async function stopRelay (dir, { timeout = 8000 } = {}) {
  const before = relayStatus(dir)
  if (before.alive === false) return { stopped: false, pid: null, running: false }

  const reply = await ipc.request(dir, { t: 'stop' }, { timeout: 3000 })
  const pid = reply?.pid ?? before.pid

  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (relayStatus(dir).alive === false) return { stopped: true, pid, running: false }
    await sleep(100)
  }
  return { stopped: false, pid, running: true }
}

// ---------------------------------------------------------------- the daemon

// The body of the background process. It owns the message store for as long as
// it runs, which is why every command goes through the socket instead of
// opening the store itself. Returns null if another relay holds the lock.
async function runRelay (dir, opts = {}) {
  const { log = console, swarm = true, say = null, bluetooth = true } = opts

  const lock = holdLock(dir)
  if (lock === null) return null

  let identity = null
  let store = null
  let node = null
  let server = null
  let purge = null
  let joining = null
  let stopping = false

  try {
    identity = opts.identity ?? await loadIdentity(dir)
    store = opts.store ?? await openStore(dir, { publicKey: identity.publicKey })
  } catch (err) {
    releaseLock(lock)
    throw err
  }

  const startedAt = Date.now()

  // code === null tears everything down without exiting, which is what a test
  // wants; anything else is a real process on its way out.
  const stop = async (code = 0) => {
    if (stopping) return
    stopping = true
    clearInterval(purge)
    // A process told to stop stops. Every step below gets a bounded amount of
    // politeness, and this is the backstop if one of them hangs anyway.
    const backstop = code === null ? null : setTimeout(() => process.exit(code), SHUTDOWN_GRACE)
    // A stop can land while discovery is still flushing. Let the join settle
    // rather than pulling the swarm out from under it half built, but do not
    // wait on it forever: flushed() has no timeout and does not always resolve.
    try { await Promise.race([joining, sleep(2000)]) } catch {}
    // sockets, then the network, then the data: by the time the store closes
    // nothing is left that could still want to write to it
    try { await server?.close() } catch {}
    try { await node?.stop() } catch {}
    try { await store.close() } catch {}
    releaseLock(lock)
    clearTimeout(backstop)
    if (code !== null) process.exit(code)
  }

  try {
    const purged = await store.purge()
    if (purged > 0) log.log(`[store] dropped ${purged} expired`)

    if (say !== null) {
      const profile = loadProfile(dir) ?? { name: 'anonymous', zone: 'unknown' }
      await store.put(create({ name: profile.name, status: 'ok', note: say, zone: profile.zone }, identity))
      log.log(`[store] ${say}`)
    }

    node = new Relay(store, {
      log,
      bluetooth,
      onChange: (msg) => log.log(`[recv] ${msg.name} (${msg.pk.slice(0, 8)}): ${msg.note}`),
      onPeers: (peers) => {
        writeState(dir, { pid: process.pid, peers, startedAt, bluetooth: node.bluetooth })
        log.log(`[peer] ${peers} in range`)
      }
    })

    server = await ipc.serve(dir, (frame) => handle(frame))
    // written before the swarm joins, because flushing discovery takes seconds
    // and the relay can already answer for itself by now
    writeState(dir, { pid: process.pid, peers: 0, startedAt, bluetooth: { state: 'starting', peers: 0 } })

    // The only timer in the process. With no peers connected the relay sits
    // idle in the event loop instead of waking up to print a heartbeat.
    purge = setInterval(() => { store.purge().catch(noop) }, PURGE_INTERVAL)

    // Never rejects. A swarm that will not join is worth a line in the log; it
    // is not worth taking down a process holding everybody's messages.
    joining = node.start({ network: swarm !== false }).then(
      () => log.log(swarm === false
        ? '[relay] bluetooth only, not on the network'
        : '[relay] joined the topic, waiting for peers'),
      (err) => log.error(`[relay] could not join the topic: ${err.message}`)
    )
    await joining
  } catch (err) {
    await stop(null)
    throw err
  }

  process.on('SIGINT', () => stop(0))
  process.on('SIGTERM', () => stop(0))

  return { stop, node, store, startedAt, get peers () { return node.peers } }

  function info () {
    return {
      pid: process.pid,
      peers: node.peers,
      bluetooth: node.bluetooth,
      startedAt,
      uptime: Date.now() - startedAt,
      stats: store.stats()
    }
  }

  async function handle (frame) {
    switch (frame.t) {
      case 'ping':
      case 'stats':
        return { ok: true, ...info() }
      case 'list':
        return { ok: true, messages: store.list(frame.query ?? {}), ...info() }
      case 'put': {
        const result = await store.put(frame.m)
        if (result === 'new') node.announce(frame.m)
        return { ok: true, result, ...info() }
      }
      case 'stop': {
        const out = { ok: true, stopping: true, ...info() }
        setTimeout(() => stop(0), 50) // answer first, then go
        return out
      }
      default:
        return undefined // an older relay meeting a newer command
    }
  }
}

// Holds the swarm and one sync session per connected peer. Anything a peer
// hands us gets forwarded to every other peer, which is the whole store and
// forward idea: we carry other people's messages, not just our own.
class Relay {
  constructor (store, { onChange = noop, onPeers = noop, swarm = null, bluetooth = true, log = null } = {}) {
    this.store = store
    this.onChange = onChange
    this.onPeers = onPeers
    this.swarm = swarm
    this.ownsSwarm = swarm === null
    this.sessions = new Set()
    this.discovery = null
    this.wantsBluetooth = bluetooth
    this.ble = null
    this.log = log
  }

  // network: false runs Bluetooth alone, which is the wifi-off case and the
  // only way to test it without two machines.
  async start ({ network = true } = {}) {
    if (network) {
      if (this.swarm === null) this.swarm = new Hyperswarm()
      this.swarm.on('connection', (connection) => this._onConnection(connection))
    }

    // Bluetooth first, and independent of the network path: it is what still
    // works with the wifi off, so it must not sit behind anything that needs
    // the wifi on. Same keypair as the swarm where there is one, so a peer met
    // over either transport is recognisably the same peer.
    await this._startBluetooth()

    if (network === false) return
    this.discovery = this.swarm.join(TOPIC, { client: true, server: true })
    await this.discovery.flushed()
  }

  async _startBluetooth () {
    if (this.wantsBluetooth === false) return
    this.ble = await ble.create({
      keyPair: this.swarm?.keyPair ?? hypercrypto.keyPair(),
      topic: TOPIC,
      onConnection: (connection) => this._onConnection(connection),
      onUpdate: (state, peers) => this.log?.log(`[ble] ${state}, ${peers} in range`)
    })
    this.log?.log(this.ble === null
      ? '[ble] no radio here, the network path is the only one'
      : `[ble] ${this.ble.state}, listening for anyone nearby`)
  }

  get bluetooth () {
    if (this.ble === null) return { state: 'unsupported', peers: 0 }
    return { state: this.ble.state, peers: this.ble.peers }
  }

  _onConnection (connection) {
    const session = attach(connection, this.store, {
      onChange: (msg) => {
        this.onChange(msg)
        this._forward(msg, session)
      }
    })
    this.sessions.add(session)
    this.onPeers(this.sessions.size)
    // BLE is the fallback while the network path has company, and the only way
    // out when it does not.
    this.ble?.setOnline(this.sessions.size > 0)

    connection.on('error', noop) // peers disappear, that is not an error worth throwing
    connection.on('close', () => {
      session.detach()
      if (this.sessions.delete(session)) this.onPeers(this.sessions.size)
    })
  }

  // Pass it on to everyone except whoever just told us about it.
  _forward (msg, from) {
    for (const session of this.sessions) {
      if (session !== from) session.announce(msg)
    }
  }

  announce (msg) {
    for (const session of this.sessions) session.announce(msg)
  }

  get peers () {
    return this.sessions.size
  }

  // Try to unannounce on the way out. Skipping it leaves this peer's address
  // in the DHT pointing at nothing, and the next peer to look the topic up
  // spends its discovery budget dialling a process that is already gone.
  // The race is the backstop: destroy has no timeout of its own, and a peer
  // that will not leave politely still has to leave.
  async stop ({ force = false, timeout = 2500 } = {}) {
    for (const session of this.sessions) session.detach()
    this.sessions.clear()
    const radio = this.ble
    this.ble = null
    if (radio !== null) await Promise.race([radio.stop(), sleep(timeout)])
    const swarm = this.swarm
    this.swarm = null
    if (this.ownsSwarm && swarm) {
      await Promise.race([swarm.destroy({ force }).catch(noop), sleep(timeout)])
    }
  }
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function noop () {}

module.exports = {
  Relay,
  TOPIC,
  relayStatus,
  liveStatus,
  ensureRelay,
  runRelay,
  stopRelay,
  holdLock,
  releaseLock,
  writeState,
  LOCK,
  STATE
}
