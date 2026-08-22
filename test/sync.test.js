const { test } = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')

const { attach, TOPIC, MAX_LINE } = require('../lib/sync.js')
const { open } = require('../lib/store.js')
const { create, messageId, toLine } = require('../lib/message.js')
const { tmp, pair, until, tick } = require('./helpers.js')

const alice = crypto.keyPair()
const bob = crypto.keyPair()

function msg (fields = {}, id = alice) {
  const { ts, ...rest } = fields
  return create({ name: 'Ana', status: 'ok', note: 'n', zone: 'Palermo', ...rest }, id, ts)
}

async function store (identity) {
  return open(tmp('imok-sync'), { publicKey: identity.publicKey })
}

test('the topic is a fixed 32 byte hash of a constant', (t) => {
  t.is(TOPIC.byteLength, 32)
  t.alike(TOPIC, crypto.hash(b4a.from('imok:v1:global')), 'derived from imok:v1:global')
})

test('a message on one side turns up on the other', async (t) => {
  const a = await store(alice)
  const b = await store(bob)
  t.teardown(() => Promise.all([a.close(), b.close()]))

  const m = msg({ note: 'from alice' })
  await a.put(m)

  const [ca, cb] = pair()
  const sa = attach(ca, a)
  const sb = attach(cb, b)
  t.teardown(() => { sa.detach(); sb.detach() })

  t.ok(await until(() => b.stats().total === 1), 'b received it')
  t.alike(b.get(messageId(m)), m, 'byte identical')
})

test('sync runs both ways over one connection', async (t) => {
  const a = await store(alice)
  const b = await store(bob)
  t.teardown(() => Promise.all([a.close(), b.close()]))

  await a.put(msg({ note: 'from alice' }))
  await b.put(msg({ note: 'from bob' }, bob))

  const [ca, cb] = pair()
  const sa = attach(ca, a)
  const sb = attach(cb, b)
  t.teardown(() => { sa.detach(); sb.detach() })

  t.ok(await until(() => a.stats().total === 2 && b.stats().total === 2), 'both converged')
  t.is(a.stats().mine, 1)
  t.is(a.stats().others, 1)
})

test('announce pushes a message created while already connected', async (t) => {
  const a = await store(alice)
  const b = await store(bob)
  t.teardown(() => Promise.all([a.close(), b.close()]))

  const [ca, cb] = pair()
  const sa = attach(ca, a)
  const sb = attach(cb, b)
  t.teardown(() => { sa.detach(); sb.detach() })

  await tick()
  t.is(b.stats().total, 0, 'nothing to sync yet')

  const m = msg({ note: 'written mid session' })
  await a.put(m)
  sa.announce(m)

  t.ok(await until(() => b.stats().total === 1), 'pushed live')
})

test('onChange fires only for messages that were actually new', async (t) => {
  const a = await store(alice)
  const b = await store(bob)
  t.teardown(() => Promise.all([a.close(), b.close()]))

  const m = msg({ note: 'once' })
  await a.put(m)

  let changes = 0
  const [ca, cb] = pair()
  const sa = attach(ca, a)
  const sb = attach(cb, b, { onChange: () => changes++ })
  t.teardown(() => { sa.detach(); sb.detach() })

  t.ok(await until(() => b.stats().total === 1))
  sa.announce(m)
  await tick()
  t.is(changes, 1, 'the re-announce did not fire it again')
})

test('a message split across chunk boundaries is reassembled', async (t) => {
  const b = await store(bob)
  t.teardown(() => b.close())

  const m = msg({ note: 'split me' })
  const line = b4a.from(toLine({ t: 'msg', m }) + '\n')

  const [ca, cb] = pair()
  const sb = attach(cb, b)
  t.teardown(() => sb.detach())

  // one byte at a time is the worst case a TCP stream can hand you
  for (let i = 0; i < line.byteLength; i++) {
    ca.write(line.subarray(i, i + 1))
  }

  t.ok(await until(() => b.stats().total === 1), 'reassembled from 1 byte chunks')
})

test('several messages arriving in a single chunk are all processed', async (t) => {
  const b = await store(bob)
  t.teardown(() => b.close())

  const msgs = [msg({ note: 'a' }), msg({ note: 'b' }), msg({ note: 'c' })]
  const blob = msgs.map((m) => toLine({ t: 'msg', m }) + '\n').join('')

  const [ca, cb] = pair()
  const sb = attach(cb, b)
  t.teardown(() => sb.detach())

  ca.write(b4a.from(blob))
  t.ok(await until(() => b.stats().total === 3), 'all three landed')
})

test('an oversized line drops that connection without taking down the process', async (t) => {
  const b = await store(bob)
  t.teardown(() => b.close())

  const [ca, cb] = pair()
  const sb = attach(cb, b)
  t.teardown(() => sb.detach())

  ca.write(b4a.from('x'.repeat(20 * 1024) + '\n'))
  t.ok(await until(() => cb.destroyed), 'connection destroyed')

  // the store is untouched and still usable, which is what "did not crash" means here
  t.is(b.stats().total, 0)
  t.is(await b.put(msg({ note: 'still working' })), 'new')
})

test('a huge line with no terminator is cut off too', async (t) => {
  const b = await store(bob)
  t.teardown(() => b.close())

  const [ca, cb] = pair()
  const sb = attach(cb, b)
  t.teardown(() => sb.detach())

  ca.write(b4a.from('x'.repeat(MAX_LINE + 100))) // no newline at all
  t.ok(await until(() => cb.destroyed), 'connection destroyed on buffer growth')
})

test('an unknown verb is ignored and the connection keeps working', async (t) => {
  const a = await store(alice)
  const b = await store(bob)
  t.teardown(() => Promise.all([a.close(), b.close()]))

  const [ca, cb] = pair()
  const sa = attach(ca, a)
  const sb = attach(cb, b)
  t.teardown(() => { sa.detach(); sb.detach() })

  ca.write(b4a.from(JSON.stringify({ t: 'unknown', payload: 'whatever' }) + '\n'))
  ca.write(b4a.from(JSON.stringify({ t: 'have' }) + '\n')) // malformed: no ids
  ca.write(b4a.from('{"broken json\n'))
  ca.write(b4a.from('\n')) // empty line
  await tick()

  t.absent(cb.destroyed, 'connection still alive')

  const m = msg({ note: 'after the junk' })
  await a.put(m)
  sa.announce(m)
  t.ok(await until(() => b.stats().total === 1), 'sync still works afterwards')
})

test('a forged message injected over the wire is rejected', async (t) => {
  const b = await store(bob)
  t.teardown(() => b.close())

  const [ca, cb] = pair()
  const sb = attach(cb, b)
  t.teardown(() => sb.detach())

  const forged = { ...msg({ note: 'genuine' }), note: 'swapped after signing' }
  ca.write(b4a.from(toLine({ t: 'msg', m: forged }) + '\n'))
  ca.write(b4a.from(toLine({ t: 'msg', m: null }) + '\n'))
  ca.write(b4a.from(toLine({ t: 'msg' }) + '\n'))
  await tick()

  t.is(b.stats().total, 0, 'nothing stored')
  t.absent(cb.destroyed, 'and it did not cost us the connection')
})

test('detach stops processing further data', async (t) => {
  const b = await store(bob)
  t.teardown(() => b.close())

  const [ca, cb] = pair()
  const sb = attach(cb, b)
  sb.detach()

  ca.write(b4a.from(toLine({ t: 'msg', m: msg({ note: 'too late' }) }) + '\n'))
  await tick()
  t.is(b.stats().total, 0, 'ignored after detach')
})
