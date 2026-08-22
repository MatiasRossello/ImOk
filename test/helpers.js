const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const { Duplex } = require('streamx')

function tmp (prefix = 'imok') {
  const dir = path.join(os.tmpdir(), prefix + '-' + Math.random().toString(36).slice(2))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// Hyperswarm hands you a streamx duplex, so a crossed pair behaves like the
// real thing without touching the network.
function pair () {
  let a = null
  let b = null
  a = new Duplex({
    write (data, cb) { if (!b.destroyed) b.push(data); cb() },
    destroy (cb) { cb() }
  })
  b = new Duplex({
    write (data, cb) { if (!a.destroyed) a.push(data); cb() },
    destroy (cb) { cb() }
  })
  return [a, b]
}

async function until (fn, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await fn()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return false
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

module.exports = { tmp, pair, until, tick }
