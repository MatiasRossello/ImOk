const fs = require('bare-fs')
const fsx = require('fs-native-extensions')
const path = require('bare-path')
const Hyperswarm = require('hyperswarm')
const { attach, TOPIC } = require('./sync.js')

const LOCK = 'relay.lock'
const STATE = 'relay.json'

// Liveness comes from an advisory lock, not from a pid in a file: if the relay
// is killed with -9 the OS drops the lock for us, so a stale file can never be
// mistaken for a running relay.
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

// Holds the swarm and one sync session per connected peer. Anything a peer
// hands us gets forwarded to every other peer, which is the whole store and
// forward idea: we carry other people's messages, not just our own.
class Relay {
  constructor (store, { onChange = noop, swarm = null } = {}) {
    this.store = store
    this.onChange = onChange
    this.swarm = swarm
    this.ownsSwarm = swarm === null
    this.sessions = new Set()
    this.discovery = null
  }

  async start () {
    if (this.swarm === null) this.swarm = new Hyperswarm()
    this.swarm.on('connection', (connection) => this._onConnection(connection))
    this.discovery = this.swarm.join(TOPIC, { client: true, server: true })
    await this.discovery.flushed()
  }

  _onConnection (connection) {
    const session = attach(connection, this.store, {
      onChange: (msg) => {
        this.onChange(msg)
        this._forward(msg, session)
      }
    })
    this.sessions.add(session)

    connection.on('error', noop) // peers disappear, that is not an error worth throwing
    connection.on('close', () => {
      session.detach()
      this.sessions.delete(session)
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

  async stop () {
    for (const session of this.sessions) session.detach()
    this.sessions.clear()
    if (this.ownsSwarm) await this.swarm?.destroy()
    this.swarm = null
  }
}

function noop () {}

module.exports = { Relay, TOPIC, relayStatus, holdLock, releaseLock, writeState, LOCK, STATE }
