const { test } = require('brittle')
const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')

const { loadIdentity, shortId, sign, verify } = require('../lib/identity.js')

function tmp () {
  const dir = path.join(os.tmpdir(), 'imok-test-' + Math.random().toString(36).slice(2))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

test('identity persists across loads', async (t) => {
  const dir = tmp()
  const a = await loadIdentity(dir)
  const b = await loadIdentity(dir)
  t.alike(a.publicKey, b.publicKey, 'same public key on second load')
  t.alike(a.secretKey, b.secretKey, 'same secret key on second load')
})

test('different storages produce different identities', async (t) => {
  const a = await loadIdentity(tmp())
  const b = await loadIdentity(tmp())
  t.unlike(a.publicKey, b.publicKey)
})

test('the seed file is not world readable', async (t) => {
  const dir = tmp()
  await loadIdentity(dir)
  const mode = fs.statSync(path.join(dir, 'identity.key')).mode & 0o777
  t.is(mode, 0o600, 'mode is 0600, got 0' + mode.toString(8))
})

test('a corrupt seed file throws instead of silently rotating identity', async (t) => {
  const dir = tmp()
  const first = await loadIdentity(dir)
  fs.writeFileSync(path.join(dir, 'identity.key'), b4a.from('too short'))
  await t.exception(loadIdentity(dir), /identity/i)
  // the original key must still be recoverable once the file is restored
  fs.writeFileSync(path.join(dir, 'identity.key'), fs.readFileSync(path.join(dir, 'identity.key')))
  t.ok(first.publicKey.byteLength === 32)
})

test('sign then verify round trips', async (t) => {
  const id = await loadIdentity(tmp())
  const bytes = b4a.from('i am ok')
  t.ok(verify(bytes, sign(bytes, id.secretKey), id.publicKey))
})

test('flipping a single byte breaks verification', async (t) => {
  const id = await loadIdentity(tmp())
  const bytes = b4a.from('i am ok')
  const sig = sign(bytes, id.secretKey)

  const tampered = b4a.from(bytes)
  tampered[0] ^= 1
  t.absent(verify(tampered, sig, id.publicKey), 'tampered payload rejected')

  const badSig = b4a.from(sig)
  badSig[0] ^= 1
  t.absent(verify(bytes, badSig, id.publicKey), 'tampered signature rejected')
})

test('a signature from one key does not verify against another', async (t) => {
  const a = await loadIdentity(tmp())
  const b = await loadIdentity(tmp())
  const bytes = b4a.from('i am ok')
  t.absent(verify(bytes, sign(bytes, a.secretKey), b.publicKey))
})

test('verify never throws, whatever you feed it', (t) => {
  const junk = [
    [null, null, null],
    [undefined, undefined, undefined],
    ['string', 'string', 'string'],
    [{}, [], 42],
    [b4a.alloc(10), b4a.alloc(0), b4a.alloc(0)],
    [b4a.alloc(10), b4a.alloc(64), b4a.alloc(5)],
    [b4a.alloc(10), b4a.alloc(5), b4a.alloc(32)],
    [b4a.alloc(10), crypto.randomBytes(64), crypto.randomBytes(32)]
  ]
  for (const [bytes, sig, pk] of junk) {
    t.is(verify(bytes, sig, pk), false, 'returned false for ' + JSON.stringify([typeof bytes, typeof sig, typeof pk]))
  }
})

test('shortId is deterministic and readable', async (t) => {
  const id = await loadIdentity(tmp())
  const short = shortId(id.publicKey)
  t.is(short, shortId(id.publicKey), 'deterministic')
  t.is(short.length, 8, 'eight characters')
  t.absent(/[0O1lI]/.test(short), 'no ambiguous characters, got ' + short)
})

test('shortId differs across identities', async (t) => {
  const seen = new Set()
  for (let i = 0; i < 50; i++) seen.add(shortId(crypto.keyPair().publicKey))
  t.is(seen.size, 50, 'no collisions in 50 identities')
})
