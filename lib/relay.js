const Hyperswarm = require('hyperswarm')
const { attach, TOPIC } = require('./sync.js')

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

module.exports = { Relay, TOPIC }
