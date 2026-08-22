const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Pipe = require('bare-pipe')
const { isWindows } = require('which-runtime')

// One request, one reply, one line of JSON each, then the connection closes.
// The cap is generous because a roster reply carries the whole store; the
// network protocol in sync.js keeps its own much tighter limit, and nothing
// here is reachable from the network.
const MAX_LINE = 4 * 1024 * 1024
const NEWLINE = 0x0a
const SOCKET = 'relay.sock'

// Unix socket paths are capped near 104 bytes by the kernel, so a deep storage
// directory has to fall back to a hashed name in the temp dir.
function socketPath (dir) {
  const full = path.resolve(dir)
  const tag = b4a.toString(crypto.hash(b4a.from(full)), 'hex').slice(0, 16)
  if (isWindows) return '\\\\.\\pipe\\imok-' + tag
  const local = path.join(full, SOCKET)
  if (b4a.byteLength(local) < 100) return local
  return path.join(os.tmpdir(), 'imok-' + tag + '.sock')
}

// handle(frame) -> reply object, or undefined for a verb we do not know.
// Resolves with { path, close } once the socket is accepting.
function serve (dir, handle) {
  const at = socketPath(dir)
  // A relay killed with -9 leaves the socket file behind and listen would fail
  // on it. Only ever reached by a process already holding the relay lock.
  if (isWindows === false) {
    try { fs.unlinkSync(at) } catch {}
  }

  const server = Pipe.createServer()
  const open = new Set()

  server.on('connection', (pipe) => {
    open.add(pipe)
    pipe.on('close', () => open.delete(pipe))
    session(pipe, handle)
  })

  // The stop request arrives over one of these connections, so closing the
  // server without hanging up on it would wait forever for it to end.
  const close = () => new Promise((resolve) => {
    for (const pipe of open) {
      try { pipe.destroy() } catch {}
    }
    open.clear()
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(done, 1000) // never let shutdown hang on a socket
    try {
      server.close(done)
    } catch {
      done()
    }
  })

  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening)
      reject(err)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      server.on('error', noop) // a client vanishing mid-write is not fatal
      resolve({ path: at, close })
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(at)
  })
}

function session (pipe, handle) {
  let buffer = b4a.alloc(0)
  let queue = Promise.resolve()

  pipe.on('error', noop)
  pipe.on('data', (data) => {
    buffer = b4a.concat([buffer, data])

    while (true) {
      const end = buffer.indexOf(NEWLINE)
      if (end === -1) break
      if (end > MAX_LINE) return pipe.destroy()
      const line = b4a.toString(buffer.subarray(0, end))
      buffer = buffer.subarray(end + 1)
      queue = queue.then(() => answer(pipe, handle, line)).catch(noop)
    }

    if (buffer.byteLength > MAX_LINE) pipe.destroy() // no terminator and over the cap
  })
}

async function answer (pipe, handle, line) {
  let frame = null
  try {
    frame = JSON.parse(line)
  } catch {
    return // unparseable, drop it and keep reading
  }
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) return

  let reply
  try {
    reply = await handle(frame)
  } catch (err) {
    reply = { ok: false, error: err.message }
  }
  if (reply === undefined) reply = { ok: false, error: 'unknown request ' + JSON.stringify(frame.t) }

  if (pipe.destroyed) return
  try {
    pipe.write(b4a.from(JSON.stringify(reply) + '\n'))
  } catch {
    // the client hung up between the check and the write
  }
}

// Resolves with the reply, or null if nothing is listening or it took too long.
// Never rejects: a missing relay is an ordinary state, not an error.
function request (dir, frame, { timeout = 3000 } = {}) {
  return new Promise((resolve) => {
    let buffer = b4a.alloc(0)
    let done = false

    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { pipe.destroy() } catch {}
      resolve(value)
    }

    const timer = setTimeout(() => finish(null), timeout)

    let pipe
    try {
      pipe = Pipe.createConnection(socketPath(dir))
    } catch {
      clearTimeout(timer)
      return resolve(null)
    }

    pipe.on('error', () => finish(null))
    pipe.on('close', () => finish(null))
    pipe.on('end', () => finish(null))
    pipe.on('connect', () => {
      try {
        pipe.write(b4a.from(JSON.stringify(frame) + '\n'))
      } catch {
        finish(null)
      }
    })
    pipe.on('data', (data) => {
      buffer = b4a.concat([buffer, data])
      const end = buffer.indexOf(NEWLINE)
      if (end === -1) {
        if (buffer.byteLength > MAX_LINE) finish(null)
        return
      }
      try {
        finish(JSON.parse(b4a.toString(buffer.subarray(0, end))))
      } catch {
        finish(null)
      }
    })
  })
}

function noop () {}

module.exports = { serve, request, socketPath, MAX_LINE, SOCKET }
