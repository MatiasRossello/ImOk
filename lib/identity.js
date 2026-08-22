const fs = require('bare-fs')
const path = require('bare-path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')

const SEED_FILE = 'identity.key'
const SEED_BYTES = 32

// 32 symbols with 0/O/1/I left out, so a short id survives being read aloud
// and typed back in. Uppercase only, which is why lowercase l can't appear.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'

// Loads the keypair from storage, creating it on first run. Idempotent.
async function loadIdentity (storagePath) {
  const file = path.join(storagePath, SEED_FILE)

  let seed = null
  try {
    seed = fs.readFileSync(file)
  } catch {
    seed = null // first run
  }

  if (seed !== null) {
    // Generating a fresh seed here would silently swap the user's identity and
    // orphan every message they ever signed. Refuse instead.
    if (seed.byteLength !== SEED_BYTES) {
      throw new Error(`identity file ${file} is corrupt: expected ${SEED_BYTES} bytes, found ${seed.byteLength}`)
    }
    return crypto.keyPair(seed)
  }

  seed = crypto.randomBytes(SEED_BYTES)
  fs.mkdirSync(storagePath, { recursive: true })
  fs.writeFileSync(file, seed, { mode: 0o600 })
  fs.chmodSync(file, 0o600) // mode is ignored when the file already exists
  return crypto.keyPair(seed)
}

// Short readable id derived from the public key. 40 bits -> 8 symbols exactly.
function shortId (publicKey) {
  let out = ''
  let acc = 0
  let bits = 0
  for (let i = 0; i < 5; i++) {
    acc = (acc << 8) | publicKey[i]
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += ALPHABET[(acc >>> bits) & 31]
    }
  }
  return out
}

function sign (bytes, secretKey) {
  return crypto.sign(bytes, secretKey)
}

// Never throws. Anything that isn't a well formed ed25519 triple is just false,
// because this runs on every message arriving from the network.
function verify (bytes, signature, publicKey) {
  if (!b4a.isBuffer(bytes)) return false
  if (!b4a.isBuffer(signature) || signature.byteLength !== 64) return false
  if (!b4a.isBuffer(publicKey) || publicKey.byteLength !== 32) return false

  try {
    return crypto.verify(bytes, signature, publicKey)
  } catch {
    return false
  }
}

module.exports = { loadIdentity, shortId, sign, verify, SEED_FILE }
