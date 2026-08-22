const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { sign, verify } = require('./identity.js')

const VERSION = 1
const STATUSES = ['ok', 'alert']

const LIMITS = {
  name: 40, // utf-8 bytes, not characters
  note: 80,
  zone: 40,
  total: 512, // the whole serialised message
  future: 5 * 60 * 1000, // clock skew we tolerate
  ttl: 72 * 60 * 60 * 1000
}

// Canonical bytes of the signable payload. Fixed field order, signature left
// out. Serialising an array rather than an object is what makes this
// independent of key insertion order, so two peers hash the same content
// to the same id.
function encodePayload (msg) {
  return b4a.from(JSON.stringify([msg.v, msg.name, msg.status, msg.note, msg.zone, msg.ts, msg.pk]))
}

function messageId (msg) {
  return b4a.toString(crypto.hash(encodePayload(msg)), 'hex')
}

function create ({ name, status, note, zone }, identity, ts = Date.now()) {
  checkField('name', name, LIMITS.name)
  checkField('note', note, LIMITS.note)
  checkField('zone', zone, LIMITS.zone)
  if (!STATUSES.includes(status)) {
    throw new Error(`status must be one of ${STATUSES.join(', ')}, got ${JSON.stringify(status)}`)
  }

  const msg = {
    v: VERSION,
    name,
    status,
    note,
    zone,
    ts,
    pk: b4a.toString(identity.publicKey, 'hex')
  }
  msg.sig = b4a.toString(sign(encodePayload(msg), identity.secretKey), 'hex')

  const size = b4a.byteLength(toLine(msg))
  if (size > LIMITS.total) {
    throw new Error(`message serialises to ${size} bytes, over the ${LIMITS.total} byte limit`)
  }
  return msg
}

// Shape, then limits, then time window, then signature. Signature last because
// it is the expensive one and the cheap checks already threw out most garbage.
function validate (msg, now = Date.now()) {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return no('not an object')
  if (msg.v !== VERSION) return no(`unsupported version ${msg.v}`)
  if (!STATUSES.includes(msg.status)) return no(`unknown status ${JSON.stringify(msg.status)}`)
  for (const field of ['name', 'note', 'zone', 'pk', 'sig']) {
    if (typeof msg[field] !== 'string') return no(`${field} is not a string`)
  }
  if (!Number.isSafeInteger(msg.ts)) return no('ts is not an integer')
  if (!isHex(msg.pk, 64)) return no('pk is not a 32 byte hex key')
  if (!isHex(msg.sig, 128)) return no('sig is not a 64 byte hex signature')

  for (const field of ['name', 'note', 'zone']) {
    const size = b4a.byteLength(msg[field])
    if (size > LIMITS[field]) return no(`${field} is ${size} bytes, over the ${LIMITS[field]} byte limit`)
  }
  const size = b4a.byteLength(toLine(msg))
  if (size > LIMITS.total) return no(`message is ${size} bytes, over the ${LIMITS.total} byte total limit`)

  if (msg.ts > now + LIMITS.future) return no('ts is too far in the future')
  if (msg.ts < now - LIMITS.ttl) return no('message has expired')

  const ok = verify(encodePayload(msg), b4a.from(msg.sig, 'hex'), b4a.from(msg.pk, 'hex'))
  if (!ok) return no('signature does not verify')

  return { ok: true, reason: null }
}

// One message per line on the wire. JSON.stringify escapes newlines inside
// strings, so a note containing \n cannot break the framing.
function toLine (msg) {
  return JSON.stringify(msg)
}

function fromLine (line) {
  try {
    const msg = JSON.parse(line)
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return null
    return msg
  } catch {
    return null
  }
}

function checkField (field, value, limit) {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  const size = b4a.byteLength(value)
  if (size > limit) throw new Error(`${field} is ${size} bytes, over the ${limit} byte limit`)
}

function isHex (value, length) {
  return value.length === length && /^[0-9a-f]+$/.test(value)
}

function no (reason) {
  return { ok: false, reason }
}

module.exports = { LIMITS, STATUSES, VERSION, encodePayload, messageId, create, validate, toLine, fromLine }
