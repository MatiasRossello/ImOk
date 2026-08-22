const { test } = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')

const { LIMITS, create, encodePayload, messageId, validate, toLine, fromLine } = require('../lib/message.js')
const { verify } = require('../lib/identity.js')

const identity = crypto.keyPair()
const base = { name: 'Ana', status: 'ok', note: 'todo bien', zone: 'Palermo' }

function signed (overrides = {}, id = identity) {
  return create({ ...base, ...overrides }, id)
}

test('encodePayload ignores key insertion order', (t) => {
  const msg = signed()
  const shuffled = {
    sig: msg.sig,
    pk: msg.pk,
    ts: msg.ts,
    zone: msg.zone,
    note: msg.note,
    status: msg.status,
    name: msg.name,
    v: msg.v
  }
  t.alike(encodePayload(msg), encodePayload(shuffled), 'identical bytes')
  t.is(messageId(msg), messageId(shuffled), 'identical id')
})

test('encodePayload excludes the signature', (t) => {
  const msg = signed()
  const forged = { ...msg, sig: 'f'.repeat(128) }
  t.alike(encodePayload(msg), encodePayload(forged), 'signature is not part of the signed bytes')
})

test('messageId is deterministic and content addressed', (t) => {
  const msg = signed()
  t.is(messageId(msg), messageId(msg))
  t.not(messageId(msg), messageId({ ...msg, note: 'otra cosa' }))
})

test('toLine never contains a newline, fromLine round trips', (t) => {
  const msg = signed({ note: 'line\nbreak\tand\ttabs' })
  const line = toLine(msg)
  t.absent(line.includes('\n'), 'no newline in the wire format')
  t.alike(fromLine(line), msg, 'round trips')
})

test('fromLine returns null on garbage instead of throwing', (t) => {
  for (const junk of ['{"garbage"', '', 'null', '[]', '"a string"', '42', 'undefined']) {
    t.is(fromLine(junk), null, JSON.stringify(junk) + ' -> null')
  }
})

test('create rejects input over the limits', (t) => {
  t.exception(() => signed({ name: 'a'.repeat(LIMITS.name + 1) }), /name/i)
  t.exception(() => signed({ note: 'a'.repeat(LIMITS.note + 1) }), /note/i)
  t.exception(() => signed({ zone: 'a'.repeat(LIMITS.zone + 1) }), /zone/i)
  t.exception(() => signed({ status: 'whatever' }), /status/i)
})

test('limits are counted in utf-8 bytes, not characters', (t) => {
  t.exception(() => signed({ name: '😀'.repeat(11) }), /name/i, '44 bytes rejected')
  t.execution(() => signed({ name: '😀'.repeat(10) }), '40 bytes accepted')
})

test('a message at every limit still fits the total byte cap', (t) => {
  const msg = signed({
    name: 'a'.repeat(LIMITS.name),
    note: 'b'.repeat(LIMITS.note),
    zone: 'c'.repeat(LIMITS.zone)
  })
  t.ok(b4a.byteLength(toLine(msg)) <= LIMITS.total, 'largest legal message is ' + b4a.byteLength(toLine(msg)) + ' bytes')
  t.ok(validate(msg).ok)
})

test('create refuses to build a message that inflates past the total cap', (t) => {
  // every quote costs two bytes once serialised, so the field limits alone are not enough
  t.exception(() => signed({
    name: '"'.repeat(LIMITS.name),
    note: '"'.repeat(LIMITS.note),
    zone: '"'.repeat(LIMITS.zone)
  }), /512 byte limit/)
})

test('validate rejects an oversized message that never went through create', (t) => {
  // a hostile peer builds and signs the payload itself, so validate is the only guard
  const msg = {
    v: 1,
    name: '"'.repeat(LIMITS.name),
    status: 'ok',
    note: '"'.repeat(LIMITS.note),
    zone: '"'.repeat(LIMITS.zone),
    ts: Date.now(),
    pk: b4a.toString(identity.publicKey, 'hex')
  }
  msg.sig = b4a.toString(crypto.sign(encodePayload(msg), identity.secretKey), 'hex')

  t.ok(b4a.byteLength(toLine(msg)) > LIMITS.total, 'serialises to ' + b4a.byteLength(toLine(msg)) + ' bytes')
  t.ok(verify(encodePayload(msg), b4a.from(msg.sig, 'hex'), identity.publicKey), 'and its signature is genuine')

  const res = validate(msg)
  t.absent(res.ok, 'still rejected')
  t.ok(/byte/i.test(res.reason), 'reason mentions size, got: ' + res.reason)
})

test('validate rejects a malformed shape', (t) => {
  const msg = signed()
  const cases = [
    [null, 'null'],
    [undefined, 'undefined'],
    ['a string', 'string'],
    [{ ...msg, v: 2 }, 'wrong version'],
    [{ ...msg, status: 'maybe' }, 'unknown status'],
    [{ ...msg, ts: 'soon' }, 'non numeric ts'],
    [{ ...msg, ts: 1.5 }, 'fractional ts'],
    [{ ...msg, pk: 'short' }, 'malformed pk'],
    [{ ...msg, sig: 'short' }, 'malformed sig'],
    [{ ...msg, name: 42 }, 'non string name']
  ]
  for (const [input, label] of cases) {
    const res = validate(input)
    t.absent(res.ok, label + ' rejected')
    t.ok(typeof res.reason === 'string' && res.reason.length > 0, label + ' has a reason')
  }
})

test('validate enforces the time window', (t) => {
  const now = Date.now()
  t.ok(validate(signed(), now).ok, 'now is fine')
  t.ok(validate({ ...signed(), ts: now + 2 * 60 * 1000 }, now).ok === false, 'unsigned edit breaks the signature first')

  // sign messages at the actual timestamps so only the window is under test
  const at = (ts) => {
    const msg = create(base, identity, ts)
    return validate(msg, now)
  }
  t.ok(at(now + 2 * 60 * 1000).ok, '2 minutes ahead accepted')
  t.absent(at(now + 10 * 60 * 1000).ok, '10 minutes ahead rejected')
  t.absent(at(now - 73 * 60 * 60 * 1000).ok, '73 hours old rejected')
  t.ok(at(now - 71 * 60 * 60 * 1000).ok, '71 hours old accepted')
})

test('validate rejects tampering and bad signatures', (t) => {
  const msg = signed()
  t.absent(validate({ ...msg, note: 'edited after signing' }).ok, 'edited note')
  t.absent(validate({ ...msg, status: 'alert' }).ok, 'edited status')
  t.absent(validate({ ...msg, sig: 'a'.repeat(128) }).ok, 'corrupt signature')

  const other = crypto.keyPair()
  t.absent(validate({ ...msg, pk: b4a.toString(other.publicKey, 'hex') }).ok, 'signature from another key')
})
