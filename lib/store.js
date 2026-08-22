const path = require('bare-path')
const b4a = require('b4a')
const Corestore = require('corestore')
const Hyperbee = require('hyperbee')
const { messageId, validate, LIMITS } = require('./message.js')

const STORE_LIMITS = {
  total: 5000, // messages held at once
  perPeer: 50 // per author, so one flooding peer cannot fill the store
}

// Hyperbee is the durable copy; the Map is the working index rebuilt on open.
// At the 5000 message cap the whole store is about 2.5 MB, so keeping it in
// memory buys sorting, filtering and eviction for free.
// ponytail: in-memory index, ceiling is STORE_LIMITS.total; index in the bee if it ever grows
class Store {
  constructor (corestore, bee, publicKey, limits) {
    this.corestore = corestore
    this.bee = bee
    this.publicKey = publicKey === null ? null : b4a.toString(publicKey, 'hex')
    this.limits = limits
    this.messages = new Map() // id -> msg
    this.perPeer = new Map() // pk -> count
  }

  async _load () {
    for await (const entry of this.bee.createReadStream()) {
      this._index(entry.key, entry.value)
    }
  }

  _index (id, msg) {
    this.messages.set(id, msg)
    this.perPeer.set(msg.pk, (this.perPeer.get(msg.pk) || 0) + 1)
  }

  _unindex (id) {
    const msg = this.messages.get(id)
    if (msg === undefined) return
    this.messages.delete(id)
    const left = (this.perPeer.get(msg.pk) || 0) - 1
    if (left > 0) this.perPeer.set(msg.pk, left)
    else this.perPeer.delete(msg.pk)
  }

  // Every message reaching the store goes through here, and the first thing it
  // does is validate. There is deliberately no other way in.
  async put (msg, now = Date.now()) {
    if (!validate(msg, now).ok) return 'rejected'

    const id = messageId(msg)
    if (this.messages.has(id)) return 'duplicate'

    if ((this.perPeer.get(msg.pk) || 0) >= this.limits.perPeer) return 'rejected'

    if (this.messages.size >= this.limits.total) await this._evictOldest()

    await this.bee.put(id, msg)
    this._index(id, msg)
    return 'new'
  }

  async _evictOldest () {
    let oldest = null
    for (const [id, msg] of this.messages) {
      if (oldest === null || msg.ts < oldest.ts) oldest = { id, ts: msg.ts }
    }
    if (oldest === null) return
    await this.bee.del(oldest.id)
    this._unindex(oldest.id)
  }

  get (id) {
    return this.messages.get(id) ?? null
  }

  ids () {
    return [...this.messages.keys()]
  }

  list ({ status, name } = {}) {
    const needle = name === undefined ? null : name.toLowerCase()
    return [...this.messages.values()]
      .filter((m) => (status === undefined || m.status === status) &&
        (needle === null || m.name.toLowerCase().includes(needle)))
      .sort((a, b) => b.ts - a.ts)
  }

  async purge (now = Date.now()) {
    const expired = []
    for (const [id, msg] of this.messages) {
      if (msg.ts < now - LIMITS.ttl) expired.push(id)
    }
    for (const id of expired) {
      await this.bee.del(id)
      this._unindex(id)
    }
    return expired.length
  }

  // peers counts distinct authors held in the store, which is not the same as
  // the number of peers currently connected. The relay reports that one.
  stats () {
    let mine = 0
    for (const msg of this.messages.values()) {
      if (msg.pk === this.publicKey) mine++
    }
    return {
      total: this.messages.size,
      mine,
      others: this.messages.size - mine,
      peers: this.perPeer.size
    }
  }

  async close () {
    await this.bee.close()
    await this.corestore.close()
  }
}

async function open (storagePath, { publicKey = null, limits = STORE_LIMITS, corestore = null } = {}) {
  const owned = corestore === null
  const store = owned ? new Corestore(path.join(storagePath, 'messages')) : corestore
  const bee = new Hyperbee(store.get({ name: 'messages' }), {
    keyEncoding: 'utf-8',
    valueEncoding: 'json'
  })
  await bee.ready()

  const self = new Store(owned ? store : null, bee, publicKey, limits)
  await self._load()
  return self
}

module.exports = { open, Store, STORE_LIMITS }
