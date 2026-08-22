const { test } = require('brittle')
const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')

const { open, STORE_LIMITS } = require('../lib/store.js')
const { create, messageId, encodePayload } = require('../lib/message.js')

const me = crypto.keyPair()
const them = crypto.keyPair()

function tmp () {
  const dir = path.join(os.tmpdir(), 'imok-store-' + Math.random().toString(36).slice(2))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function msg (overrides = {}, id = me) {
  const { ts, ...fields } = overrides
  return create({ name: 'Ana', status: 'ok', note: 'n', zone: 'Palermo', ...fields }, id, ts)
}

test('put reports new, then duplicate, and total tracks it', async (t) => {
  const store = await open(tmp(), { publicKey: me.publicKey })
  t.teardown(() => store.close())

  const m = msg()
  t.is(await store.put(m), 'new')
  t.is(store.stats().total, 1)
  t.is(await store.put(m), 'duplicate', 'same message again')
  t.is(store.stats().total, 1, 'total did not move')
  t.alike(store.get(messageId(m)), m, 'readable back')
})

test('put rejects an invalid signature and stores nothing', async (t) => {
  const store = await open(tmp(), { publicKey: me.publicKey })
  t.teardown(() => store.close())

  const forged = { ...msg(), note: 'edited after signing' }
  t.is(await store.put(forged), 'rejected')
  t.is(store.stats().total, 0)
  t.is(store.get(messageId(forged)), null)
})

test('there is no path that stores without validating', async (t) => {
  const store = await open(tmp(), { publicKey: me.publicKey })
  t.teardown(() => store.close())

  const junk = [
    null,
    'a string',
    {},
    { ...msg(), v: 99 },
    { ...msg(), sig: 'a'.repeat(128) },
    { ...msg(), status: 'alert' },
    { ...msg(), note: 'x'.repeat(200) }
  ]
  for (const bad of junk) t.is(await store.put(bad), 'rejected', JSON.stringify(bad)?.slice(0, 40) ?? 'null')
  t.is(store.stats().total, 0, 'nothing got through')
})

test('messages survive close and reopen', async (t) => {
  const dir = tmp()
  const m = msg({ note: 'persist me' })

  const first = await open(dir, { publicKey: me.publicKey })
  t.is(await first.put(m), 'new')
  await first.close()

  const second = await open(dir, { publicKey: me.publicKey })
  t.teardown(() => second.close())
  t.is(second.stats().total, 1, 'still there after reopen')
  t.alike(second.get(messageId(m)), m, 'and identical')
  t.is(await second.put(m), 'duplicate', 'dedup survived the restart too')
})

test('a flooding peer is capped at perPeer messages', async (t) => {
  const store = await open(tmp(), { publicKey: me.publicKey })
  t.teardown(() => store.close())

  let accepted = 0
  let rejected = 0
  for (let i = 0; i < STORE_LIMITS.perPeer + 1; i++) {
    const res = await store.put(msg({ note: 'flood ' + i }, them))
    if (res === 'new') accepted++
    else rejected++
  }
  t.is(accepted, STORE_LIMITS.perPeer, 'accepted exactly the cap')
  t.is(rejected, 1, 'message ' + (STORE_LIMITS.perPeer + 1) + ' rejected')

  t.is(await store.put(msg({ note: 'mine still fits' })), 'new', 'another peer is unaffected')
})

test('reaching the total cap evicts the oldest first', async (t) => {
  // the real cap is 5000; overriding it keeps the test fast without changing the code path
  const store = await open(tmp(), { publicKey: me.publicKey, limits: { total: 5, perPeer: 50 } })
  t.teardown(() => store.close())

  const now = Date.now()
  const sent = []
  for (let i = 0; i < 5; i++) {
    const m = msg({ note: 'm' + i, ts: now - (10 - i) * 1000 })
    sent.push(m)
    t.is(await store.put(m), 'new')
  }
  t.is(store.stats().total, 5, 'at the cap')

  const newest = msg({ note: 'newest', ts: now })
  t.is(await store.put(newest), 'new', 'still accepted')
  t.is(store.stats().total, 5, 'still at the cap')
  t.is(store.get(messageId(sent[0])), null, 'oldest was evicted')
  t.ok(store.get(messageId(sent[1])), 'second oldest survived')
  t.ok(store.get(messageId(newest)), 'newest is in')
})

test('purge drops expired messages and reports how many', async (t) => {
  const store = await open(tmp(), { publicKey: me.publicKey })
  t.teardown(() => store.close())

  const now = Date.now()
  const old = msg({ note: 'old', ts: now })
  const fresh = msg({ note: 'fresh', ts: now })
  await store.put(old)
  await store.put(fresh)

  t.is(await store.purge(now), 0, 'nothing expired yet')

  // 73 hours later the ttl of 72 hours has passed for both
  t.is(await store.purge(now + 73 * 60 * 60 * 1000), 2, 'both expired')
  t.is(store.stats().total, 0)
  t.is(store.get(messageId(old)), null)
})

test('purge frees the perPeer budget', async (t) => {
  const store = await open(tmp(), { publicKey: me.publicKey, limits: { total: 100, perPeer: 2 } })
  t.teardown(() => store.close())

  const now = Date.now()
  t.is(await store.put(msg({ note: 'a', ts: now }, them)), 'new')
  t.is(await store.put(msg({ note: 'b', ts: now }, them)), 'new')
  t.is(await store.put(msg({ note: 'c', ts: now }, them)), 'rejected', 'at the cap')

  await store.purge(now + 73 * 60 * 60 * 1000)
  t.is(await store.put(msg({ note: 'd' }, them)), 'new', 'budget freed after purge')
})

test('stats separates my messages from everyone elses', async (t) => {
  const store = await open(tmp(), { publicKey: me.publicKey })
  t.teardown(() => store.close())

  await store.put(msg({ note: 'mine 1' }))
  await store.put(msg({ note: 'mine 2' }))
  await store.put(msg({ note: 'theirs' }, them))
  await store.put(msg({ note: 'a third party' }, crypto.keyPair()))

  const s = store.stats()
  t.is(s.total, 4)
  t.is(s.mine, 2)
  t.is(s.others, 2)
  t.is(s.peers, 3, 'three distinct authors')
})

test('ids and list read back what was stored', async (t) => {
  const store = await open(tmp(), { publicKey: me.publicKey })
  t.teardown(() => store.close())

  const now = Date.now()
  const a = msg({ name: 'Ana', note: 'first', ts: now - 3000 })
  const b = msg({ name: 'Beto', status: 'alert', note: 'second', ts: now - 2000 }, them)
  const c = msg({ name: 'Caro', note: 'third', ts: now - 1000 })
  for (const m of [a, b, c]) await store.put(m)

  t.alike(store.ids().sort(), [a, b, c].map(messageId).sort(), 'ids covers everything')

  const all = store.list()
  t.is(all.length, 3)
  t.alike(all.map((m) => m.note), ['third', 'second', 'first'], 'newest first')

  t.alike(store.list({ status: 'alert' }).map((m) => m.name), ['Beto'], 'filter by status')
  t.alike(store.list({ name: 'an' }).map((m) => m.name), ['Ana'], 'filter by name, case insensitive substring')
  t.alike(store.list({ name: 'nobody' }), [], 'no match is an empty list')
})
