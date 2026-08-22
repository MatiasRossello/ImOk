const ipc = require('./ipc.js')
const { relayStatus, ensureRelay } = require('./relay.js')
const { open: openStore } = require('./store.js')

// Only one process can hold the message store open, and while the relay is
// running that process is the relay. So a command talks to it over the local
// socket, and only opens the store itself when there is no relay to ask. In
// that case it hands ownership over on close: store first, relay after, never
// both at once.
async function connect (dir, opts = {}) {
  if (relayStatus(dir).alive) {
    const ping = await ipc.request(dir, { t: 'ping' }, { timeout: 1500 })
    if (ping !== null && ping.ok === true) return remote(dir, ping)
    // the lock is held but nobody answered: the relay is on its way up or on
    // its way down, and either way we must not open the store underneath it
    return unreachable(dir)
  }
  return local(dir, opts)
}

function view (reply) {
  return {
    alive: true,
    pid: reply.pid ?? null,
    peers: reply.peers ?? 0,
    bluetooth: reply.bluetooth ?? null,
    uptime: reply.uptime ?? 0
  }
}

function remote (dir, ping) {
  const client = {
    mode: 'relay',
    relay: view(ping),
    stats: ping.stats,

    // A relay that stops answering mid-request leaves the caller with nothing
    // written and nothing read. absorb flips the mode so the command says that
    // rather than printing an empty roster or a check-in that never happened.
    async put (msg) {
      const reply = await ipc.request(dir, { t: 'put', m: msg })
      return absorb(client, reply, (r) => r.result) ?? 'unreachable'
    },

    async list (query) {
      const reply = await ipc.request(dir, { t: 'list', query: query ?? {} })
      return absorb(client, reply, (r) => r.messages) ?? []
    },

    async refresh () {
      const reply = await ipc.request(dir, { t: 'stats' })
      absorb(client, reply, () => null)
      return client.stats
    },

    async close () {
      return client.relay
    }
  }
  return client
}

function absorb (client, reply, pick) {
  if (reply === null || reply.ok !== true) {
    client.mode = 'unreachable'
    return null
  }
  client.mode = 'relay'
  client.relay = view(reply)
  if (reply.stats) client.stats = reply.stats
  return pick(reply)
}

// The relay holds the lock but is not answering. Touching the store now would
// mean prying it out from under a live process, so we do nothing and say so.
// Every caller checks the mode; nothing here pretends the write happened.
function unreachable (dir) {
  const status = relayStatus(dir)
  return {
    mode: 'unreachable',
    relay: { ...status, alive: true },
    stats: { total: 0, mine: 0, others: 0, peers: 0 },
    async put () { return 'unreachable' },
    async list () { return [] },
    async refresh () { return this.stats },
    async close () { return this.relay }
  }
}

async function local (dir, opts) {
  const { publicKey = null, spawn = true, execPath = null, entrypoint = null, timeout = 2500, args = [] } = opts
  const store = await openStore(dir, { publicKey })
  let closed = false

  const client = {
    mode: 'local',
    relay: { alive: false, pid: null, peers: 0, uptime: 0 },
    stats: store.stats(),

    async put (msg) {
      const result = await store.put(msg)
      client.stats = store.stats()
      return result
    },

    async list (query) {
      return store.list(query ?? {})
    },

    async refresh () {
      client.stats = store.stats()
      return client.stats
    },

    // Closing releases the store, and only then is it safe to start the relay:
    // it needs the same exclusive lock we were holding a moment ago.
    async close () {
      if (closed) return client.relay
      closed = true
      await store.close()
      if (spawn === false || execPath === null) return client.relay
      const started = await ensureRelay(dir, { execPath, entrypoint, timeout, args })
      client.relay = {
        alive: started.alive,
        pid: started.pid,
        peers: started.peers,
        uptime: started.uptime
      }
      return client.relay
    }
  }

  await store.purge()
  client.stats = store.stats()
  return client
}

module.exports = { connect }
