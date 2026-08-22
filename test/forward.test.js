const { test } = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')

const { attach } = require('../lib/sync.js')
const { open, STORE_LIMITS } = require('../lib/store.js')
const { create, messageId, validate } = require('../lib/message.js')
const { tmp, pair, until, tick } = require('./helpers.js')

// Three stores, no network, no terminals. This is the whole store and forward
// idea reduced to something that either passes or fails in a second.
async function peer (name) {
  const identity = crypto.keyPair()
  const store = await open(tmp('imok-fwd-' + name), { publicKey: identity.publicKey })
  return { name, identity, store, pk: b4a.toString(identity.publicKey, 'hex') }
}

function link (x, y) {
  const [cx, cy] = pair()
  const sx = attach(cx, x.store)
  const sy = attach(cy, y.store)
  return {
    sx,
    sy,
    cut () {
      sx.detach()
      sy.detach()
      cx.destroy()
      cy.destroy()
    }
  }
}

test('a message reaches C through B after A is gone', async (t) => {
  const a = await peer('a')
  const b = await peer('b')
  const c = await peer('c')
  t.teardown(() => Promise.all([a.store.close(), b.store.close(), c.store.close()]))

  // 1. A writes, on its own
  const m = create({ name: 'Ana', status: 'alert', note: 'necesito ayuda', zone: 'Palermo' }, a.identity)
  t.is(await a.store.put(m), 'new')
  t.is(a.store.stats().mine, 1, 'A has one message of its own')

  // 2. B shows up and syncs
  const ab = link(a, b)
  t.ok(await until(() => b.store.stats().total === 1), 'B synced')
  t.is(b.store.stats().others, 1, 'B is carrying one message that is not its own')
  t.is(b.store.stats().mine, 0, 'and none of its own')

  // 3. A dies
  ab.cut()
  await a.store.close()

  // 4. C shows up, and only ever talks to B
  const bc = link(b, c)
  t.teardown(() => bc.cut())
  t.ok(await until(() => c.store.stats().total === 1), 'C got it from B, with A gone')

  // 5. the signature survived the hop
  const relayed = c.store.get(messageId(m))
  t.ok(relayed, 'C holds the message')
  t.ok(validate(relayed).ok, 'and A\'s signature still verifies in C')

  // 6. the author is still A, not the peer that passed it on
  t.is(relayed.pk, a.pk, 'pk is A\'s')
  t.not(relayed.pk, b.pk, 'B did not rewrite the author')
  t.alike(relayed, m, 'byte for byte the message A signed')
})

test('a message survives three hops and still verifies against the original key', async (t) => {
  const peers = []
  for (const name of ['a', 'b', 'c', 'd']) peers.push(await peer(name))
  t.teardown(() => Promise.all(peers.map((p) => p.store.close().catch(() => {}))))

  const [a, b, c, d] = peers
  const m = create({ name: 'Ana', status: 'ok', note: 'tres saltos', zone: 'Centro' }, a.identity)
  await a.store.put(m)

  // strictly a chain: a - b, then b - c, then c - d, each link cut before the next
  const ab = link(a, b)
  t.ok(await until(() => b.store.stats().total === 1), 'hop 1')
  ab.cut()

  const bc = link(b, c)
  t.ok(await until(() => c.store.stats().total === 1), 'hop 2')
  bc.cut()

  const cd = link(c, d)
  t.teardown(() => cd.cut())
  t.ok(await until(() => d.store.stats().total === 1), 'hop 3')

  const relayed = d.store.get(messageId(m))
  t.ok(validate(relayed).ok, 'still verifies after three hops')
  t.is(relayed.pk, a.pk, 'still attributed to A')
  t.is(d.store.stats().others, 1)
})

test('HAVE offers everything held, not just what the peer wrote itself', async (t) => {
  const a = await peer('a')
  const b = await peer('b')
  const c = await peer('c')
  t.teardown(() => Promise.all([a.store.close(), b.store.close(), c.store.close()]))

  // B writes nothing of its own, it only ever carries other people's messages
  await a.store.put(create({ name: 'Ana', status: 'ok', note: 'de A', zone: 'z' }, a.identity))
  const ab = link(a, b)
  t.ok(await until(() => b.store.stats().total === 1))
  ab.cut()

  t.is(b.store.stats().mine, 0, 'B wrote nothing')

  const bc = link(b, c)
  t.teardown(() => bc.cut())
  t.ok(await until(() => c.store.stats().total === 1), 'B still offered it onward')
})

test('a flooding relay cannot fill everyone elses store', async (t) => {
  const flooder = await peer('flooder')
  const victim = await peer('victim')
  t.teardown(() => Promise.all([flooder.store.close(), victim.store.close()]))

  // the flooder bypasses its own cap by writing straight to its bee
  const overflow = STORE_LIMITS.perPeer + 25
  for (let i = 0; i < overflow; i++) {
    const m = create({ name: 'Flood', status: 'ok', note: 'spam ' + i, zone: 'z' }, flooder.identity)
    await flooder.store.bee.put(messageId(m), m)
    flooder.store._index(messageId(m), m)
  }
  t.is(flooder.store.stats().total, overflow, 'flooder is holding ' + overflow)

  const fv = link(flooder, victim)
  t.teardown(() => fv.cut())
  await until(() => victim.store.stats().total >= STORE_LIMITS.perPeer)
  await tick()

  t.is(victim.store.stats().total, STORE_LIMITS.perPeer, 'victim capped at ' + STORE_LIMITS.perPeer)
})
