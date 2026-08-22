const { test } = require('brittle')
const os = require('bare-os')
const path = require('bare-path')
const process = require('bare-process')
const crypto = require('hypercore-crypto')

const ipc = require('../lib/ipc.js')
const { relayStatus, ensureRelay, stopRelay, liveStatus } = require('../lib/relay.js')
const { create } = require('../lib/message.js')
const { connect } = require('../lib/client.js')
const { tmp, until } = require('./helpers.js')

const ENTRY = path.join(__dirname, '..', 'bin.mjs')
const isDev = path.basename(os.execPath(), path.extname(os.execPath())) === 'bare'

// The relay under test never joins the swarm: the daemon plumbing is what is
// being checked here, and sync has its own tests that need no processes.
function spawnOpts () {
  return {
    execPath: os.execPath(),
    entrypoint: isDev ? ENTRY : null,
    args: ['--no-swarm', '--no-ble'],
    timeout: 15000
  }
}

async function reap (dir) {
  const status = relayStatus(dir)
  if (status.alive === false) return
  await stopRelay(dir, { timeout: 5000 })
  const left = relayStatus(dir)
  if (left.alive && left.pid) {
    try { process.kill(left.pid, 'SIGKILL') } catch {}
  }
}

// ---------------------------------------------------------------------- ipc

test('a request with nothing listening resolves null rather than throwing', async (t) => {
  const dir = tmp('imok-ipc')
  t.is(await ipc.request(dir, { t: 'ping' }, { timeout: 300 }), null)
})

test('one request, one reply, over a socket in the storage directory', async (t) => {
  const dir = tmp('imok-ipc')
  const server = await ipc.serve(dir, (frame) => ({ ok: true, echo: frame.what }))
  t.teardown(() => server.close())

  const reply = await ipc.request(dir, { t: 'say', what: 'hola' })
  t.alike(reply, { ok: true, echo: 'hola' })
})

test('a reply too large for one chunk is reassembled', async (t) => {
  const dir = tmp('imok-ipc')
  const big = 'x'.repeat(400 * 1024)
  const server = await ipc.serve(dir, () => ({ ok: true, big }))
  t.teardown(() => server.close())

  const reply = await ipc.request(dir, { t: 'big' })
  t.is(reply.big.length, big.length, 'came back whole')
})

test('an unknown verb is answered, not fatal', async (t) => {
  const dir = tmp('imok-ipc')
  const server = await ipc.serve(dir, (frame) => (frame.t === 'known' ? { ok: true } : undefined))
  t.teardown(() => server.close())

  const unknown = await ipc.request(dir, { t: 'nonsense' })
  t.is(unknown.ok, false)
  t.ok(unknown.error.includes('nonsense'), 'says which verb it did not know')
  t.is((await ipc.request(dir, { t: 'known' })).ok, true, 'the server is still up')
})

test('a handler that throws answers with the reason and stays up', async (t) => {
  const dir = tmp('imok-ipc')
  const server = await ipc.serve(dir, (frame) => {
    if (frame.t === 'boom') throw new Error('exploded')
    return { ok: true }
  })
  t.teardown(() => server.close())

  t.alike(await ipc.request(dir, { t: 'boom' }), { ok: false, error: 'exploded' })
  t.is((await ipc.request(dir, { t: 'fine' })).ok, true)
})

test('the socket path is stable and lands inside the storage directory', (t) => {
  const dir = tmp('imok-ipc')
  t.is(ipc.socketPath(dir), ipc.socketPath(dir), 'deterministic')
  t.not(ipc.socketPath(dir), ipc.socketPath(tmp('imok-ipc')), 'per storage')
})

// ------------------------------------------------------------------- daemon

test('with no relay running the status is honest about it', async (t) => {
  const dir = tmp('imok-relay')
  t.alike(relayStatus(dir), { alive: false, pid: null, peers: 0, uptime: 0 })
  t.alike(await liveStatus(dir), { alive: false, pid: null, peers: 0, uptime: 0 })
})

test('ensureRelay starts one, and starting again reuses it', async (t) => {
  const dir = tmp('imok-relay')
  t.teardown(() => reap(dir))

  const first = await ensureRelay(dir, spawnOpts())
  t.is(first.alive, true, 'came up')
  t.is(first.alreadyRunning, false, 'we started it')
  t.ok(first.pid > 0, 'reports a pid')
  t.is(relayStatus(dir).alive, true, 'holds the lock')

  const second = await ensureRelay(dir, spawnOpts())
  t.is(second.alreadyRunning, true, 'the second call did not start another')
  t.is(second.pid, first.pid, 'same process')
})

test('the relay owns the store and answers for it', async (t) => {
  const dir = tmp('imok-relay')
  t.teardown(() => reap(dir))

  const started = await ensureRelay(dir, spawnOpts())
  t.is(started.alive, true)

  const identity = crypto.keyPair()
  const message = create({ name: 'Ana', status: 'ok', note: 'from a test', zone: 'Centro' }, identity)

  const put = await ipc.request(dir, { t: 'put', m: message })
  t.is(put.result, 'new', 'the relay took it')
  t.is((await ipc.request(dir, { t: 'put', m: message })).result, 'duplicate', 'and dedups it')

  const list = await ipc.request(dir, { t: 'list', query: {} })
  t.is(list.messages.length, 1)
  t.is(list.messages[0].note, 'from a test')

  const filtered = await ipc.request(dir, { t: 'list', query: { name: 'nobody' } })
  t.is(filtered.messages.length, 0, 'the filter is applied on the relay side')

  const bad = { ...message, note: 'tampered' }
  t.is((await ipc.request(dir, { t: 'put', m: bad })).result, 'rejected', 'still validates')
})

test('a command reads through the relay instead of opening the store', async (t) => {
  const dir = tmp('imok-relay')
  t.teardown(() => reap(dir))

  await ensureRelay(dir, spawnOpts())

  const client = await connect(dir, { ...spawnOpts() })
  t.teardown(() => client.close())
  t.is(client.mode, 'relay', 'went over the socket')

  const identity = crypto.keyPair()
  const message = create({ name: 'Beto', status: 'alert', note: 'help', zone: 'Sur' }, identity)
  t.is(await client.put(message), 'new')

  const rows = await client.list({})
  t.is(rows.length, 1)
  t.is(rows[0].status, 'alert')
  t.is(client.relay.alive, true)
})

test('with no relay a command opens the store itself and hands it over on close', async (t) => {
  const dir = tmp('imok-relay')
  t.teardown(() => reap(dir))

  const identity = crypto.keyPair()
  const client = await connect(dir, { publicKey: identity.publicKey, ...spawnOpts() })
  t.is(client.mode, 'local', 'nothing to talk to yet')
  t.is(await client.put(create({ name: 'Ana', status: 'ok', note: 'solo', zone: 'Centro' }, identity)), 'new')
  t.is(relayStatus(dir).alive, false, 'no relay while we hold the store')

  const relay = await client.close()
  t.is(relay.alive, true, 'closing handed the store to a relay')

  const after = await ipc.request(dir, { t: 'list', query: {} })
  t.is(after.messages.length, 1, 'the relay picked up what the command wrote')
})

test('a relay that dies mid-request leaves the command saying so', async (t) => {
  const dir = tmp('imok-relay')
  t.teardown(() => reap(dir))

  const started = await ensureRelay(dir, spawnOpts())
  t.is(started.alive, true)

  const client = await connect(dir, { ...spawnOpts() })
  t.is(client.mode, 'relay', 'it was answering when we connected')

  process.kill(started.pid, 'SIGKILL')
  await until(() => relayStatus(dir).alive === false, 10000)

  const identity = crypto.keyPair()
  const message = create({ name: 'Ana', status: 'ok', note: 'into the void', zone: 'Centro' }, identity)
  t.is(await client.put(message), 'unreachable', 'never claims a write that did not happen')
  t.is(client.mode, 'unreachable', 'and the command can tell')
})

test('a relay killed with -9 leaves no lock behind and a new one starts', async (t) => {
  const dir = tmp('imok-relay')
  t.teardown(() => reap(dir))

  const first = await ensureRelay(dir, spawnOpts())
  t.is(first.alive, true)

  process.kill(first.pid, 'SIGKILL')
  t.ok(await until(() => relayStatus(dir).alive === false, 10000), 'the lock came free on its own')

  const second = await ensureRelay(dir, spawnOpts())
  t.is(second.alive, true, 'a new relay took over')
  t.is(second.alreadyRunning, false)
  t.not(second.pid, first.pid, 'a different process')
})

test('stopping a relay releases the lock before it returns', async (t) => {
  const dir = tmp('imok-relay')
  t.teardown(() => reap(dir))

  const started = await ensureRelay(dir, spawnOpts())
  t.is(started.alive, true)

  const stopped = await stopRelay(dir, { timeout: 10000 })
  t.is(stopped.stopped, true)
  t.is(stopped.pid, started.pid)
  t.is(relayStatus(dir).alive, false, 'the lock is free the moment stopRelay returns')

  t.alike(await stopRelay(dir), { stopped: false, pid: null, running: false }, 'stopping nothing says so')
})
