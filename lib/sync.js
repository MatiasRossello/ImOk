const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { toLine, fromLine, messageId } = require('./message.js')

// Fixed global topic. Constant, not configurable: every peer meets in the same
// place or the network partitions for no good reason. Bumping this string is a
// deliberate hard reset -- it starts an empty network, and peers on the old one
// become unreachable, because there is no way to withdraw a message once it has
// been handed to somebody else. v2 was the reset before the demo.
const TOPIC = crypto.hash(b4a.from('imok:v2:global'))

const PROTOCOL_VERSION = 1
const MAX_LINE = 8 * 1024
const HAVE_CHUNK = 200
const NEWLINE = 0x0a

// Symmetric anti-entropy. Both sides run this same code over one connection;
// there is no client and no server.
//
//   -> hello { t, v }
//   -> have  { t, ids }   what we hold, ours and other people's alike
//   <- want  { t, ids }   what they are missing
//   -> msg   { t, m }     one message per line
//
function attach (connection, store, { onChange = noop } = {}) {
  let buffer = b4a.alloc(0)
  let detached = false
  let queue = Promise.resolve()

  connection.on('data', onData)
  connection.on('error', noop) // a peer vanishing is normal, not an exception
  connection.on('close', detach)

  send({ t: 'hello', v: PROTOCOL_VERSION })
  sendHave(store.ids())

  return { detach, announce }

  function detach () {
    if (detached) return
    detached = true
    connection.removeListener('data', onData)
  }

  // Tell the peer about a message we just took on, so a live session does not
  // have to wait for the next reconnect.
  function announce (msg) {
    sendHave([messageId(msg)])
  }

  function send (frame) {
    if (detached || connection.destroyed) return
    try {
      // bytes, not a string: the framing counts bytes and a transport is free
      // to hand a string straight back to the other side
      connection.write(b4a.from(toLine(frame) + '\n'))
    } catch {
      // the socket died between the check and the write
    }
  }

  function sendHave (ids) {
    for (let i = 0; i < ids.length; i += HAVE_CHUNK) {
      send({ t: 'have', ids: ids.slice(i, i + HAVE_CHUNK) })
    }
  }

  function onData (data) {
    if (detached) return
    buffer = b4a.concat([buffer, data])

    while (true) {
      const end = buffer.indexOf(NEWLINE)
      if (end === -1) break
      if (end > MAX_LINE) return kill()
      const line = b4a.toString(buffer.subarray(0, end))
      buffer = buffer.subarray(end + 1)
      queue = queue.then(() => handle(line)).catch(noop)
    }

    // no terminator in sight and already over the cap: this peer is not framing
    if (buffer.byteLength > MAX_LINE) kill()
  }

  function kill () {
    detach()
    connection.destroy()
  }

  async function handle (line) {
    if (detached) return
    const frame = fromLine(line)
    if (frame === null) return // unparseable line, drop it and read on

    switch (frame.t) {
      case 'hello':
        return
      case 'have':
        return onHave(frame)
      case 'want':
        return onWant(frame)
      case 'msg':
        return onMsg(frame)
      default:
        return // unknown verb, so a newer peer can add one without breaking us
    }
  }

  function onHave (frame) {
    if (!Array.isArray(frame.ids)) return
    const missing = frame.ids.filter((id) => typeof id === 'string' && store.get(id) === null)
    if (missing.length > 0) send({ t: 'want', ids: missing })
  }

  function onWant (frame) {
    if (!Array.isArray(frame.ids)) return
    for (const id of frame.ids) {
      if (typeof id !== 'string') continue
      const msg = store.get(id)
      if (msg !== null) send({ t: 'msg', m: msg })
    }
  }

  async function onMsg (frame) {
    // put validates. Nothing off the wire reaches the store any other way.
    const result = await store.put(frame.m)
    if (result === 'new') onChange(frame.m)
  }
}

function noop () {}

module.exports = { attach, TOPIC, MAX_LINE, HAVE_CHUNK, PROTOCOL_VERSION }
