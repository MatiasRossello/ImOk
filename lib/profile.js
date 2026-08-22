const fs = require('bare-fs')
const path = require('bare-path')
const { LIMITS } = require('./message.js')
const b4a = require('b4a')

const FILE = 'profile.json'

// Who you are on screen: a name and a rough area. Asked once on first run.
function loadProfile (storagePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(storagePath, FILE), 'utf8'))
    if (typeof raw?.name !== 'string' || typeof raw?.zone !== 'string') return null
    if (raw.name.length === 0 || raw.zone.length === 0) return null
    return { name: raw.name, zone: raw.zone }
  } catch {
    return null
  }
}

function saveProfile (storagePath, profile) {
  const clean = {
    name: clip(profile.name, LIMITS.name),
    zone: clip(profile.zone, LIMITS.zone)
  }
  fs.mkdirSync(storagePath, { recursive: true })
  fs.writeFileSync(path.join(storagePath, FILE), JSON.stringify(clean, null, 2) + '\n')
  return clean
}

// The wire limits are in utf-8 bytes, so trim by bytes and not by characters.
function clip (text, limit) {
  let out = ''
  for (const character of String(text).trim()) {
    if (b4a.byteLength(out + character) > limit) break
    out += character
  }
  return out
}

module.exports = { loadProfile, saveProfile, clip, FILE }
