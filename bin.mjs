import { command, flag, arg, summary, description, rest } from 'paparam'
import { persistent } from 'bare-storage'
import process from 'bare-process'
import os from 'bare-os'
import tty from 'bare-tty'
import { isWindows } from 'which-runtime'
import path from 'bare-path'
import FileLog from 'bare-file-logger'
import Console from 'bare-console'
import pkg from './package.json'
import App from './app.js'
import { loadIdentity, shortId } from './lib/identity.js'
import { loadProfile, saveProfile } from './lib/profile.js'
import { open as openStore } from './lib/store.js'
import { create } from './lib/message.js'
import { Relay, relayStatus, holdLock, releaseLock, writeState } from './lib/relay.js'
import * as render from './lib/render.js'

const appName = pkg.productName || pkg.name
const isDev = path.basename(Bare.argv[0], path.extname(Bare.argv[0])) === 'bare'

// paparam holds state per flag object, so every command gets its own copies
const common = () => [
  flag('--storage <dir>', 'custom storage directory'),
  flag('--no-updates', 'disable OTA updates for this run'),
  flag('--update-window <ms>', 'updater wait in milliseconds'),
  flag('--columns <n>', 'force a terminal width').hide(),
  flag('--no-colour', 'plain output with no escape codes')
]

let run = null

// stdin arrives in chunks that do not line up with questions, so leftover
// input has to survive between calls or the second answer gets eaten.
// Declared up here because the commands run before the bottom of this file.
let pending = ''
let closed = false

const alert = command(
  'alert',
  summary('Check in asking for help'),
  arg('[note]', 'a short note to travel with it'),
  ...common(),
  (cmd) => { run = () => checkIn(cmd, 'alert') }
)

const list = command(
  'list',
  summary('Everything this device is carrying'),
  arg('[who]', 'only show names containing this text'),
  ...common(),
  (cmd) => { run = () => showRoster(cmd) }
)

const me = command(
  'me',
  summary('Your identity and what you are carrying'),
  ...common(),
  (cmd) => { run = () => showMe(cmd) }
)

const relay = command(
  'relay',
  summary('Whether the background relay is running'),
  flag('--foreground', 'run the relay here instead of reporting on it').hide(),
  flag('--say <note>', 'publish a note before relaying').hide(),
  ...common(),
  (cmd) => { run = () => (cmd.flags.foreground ? foregroundRelay(cmd) : showRelay(cmd)) }
)

const cmd = command(
  appName,
  summary(pkg.description),
  description('Run with no command to check in as ok.'),
  flag('--version|-v', 'Print the current version'),
  flag('--updater', 'run updater daemon').hide(),
  ...common(),
  alert,
  list,
  me,
  relay,
  (cmd) => { run = () => checkIn(cmd, 'ok') }
)

cmd.parse(Bare.argv.slice(isDev ? 2 : 1))

if (cmd.flags.help) Bare.exit()
if (cmd.flags.version) {
  console.log(`${appName} v${pkg.version}`)
  Bare.exit()
}

if (cmd.flags.updater) {
  await runUpdater(dirFor(cmd), updateWindow(cmd.flags.updateWindow))
  Bare.exit()
}

if (run !== null) {
  try {
    await run()
  } catch (err) {
    console.error(`[${appName}] ${err.message}`)
    Bare.exit(1)
  }
}

// ------------------------------------------------------------------ commands

async function checkIn (cmd, status) {
  const { dir, identity, store } = await session(cmd)
  try {
    const profile = await ensureProfile(dir)
    const note = (cmd.args?.note || '').trim() || (status === 'alert' ? 'needs help' : 'all good')
    const message = create({ name: profile.name, status, note, zone: profile.zone }, identity)
    await store.put(message)

    const relay = relayStatus(dir)
    console.log(render.checkIn({ status, peers: relay.peers }))
    if (!relay.alive) {
      console.log(render.relayReport(relay).trimEnd())
      console.log()
    }
  } finally {
    await store.close()
  }
}

async function showRoster (cmd) {
  const { dir, store } = await session(cmd)
  try {
    const who = cmd.args?.who || null
    const messages = store.list(who ? { name: who } : {})
    console.log(render.roster(messages, {
      columns: columnsFor(cmd),
      query: who,
      peers: relayStatus(dir).peers
    }))
  } finally {
    await store.close()
  }
}

async function showMe (cmd) {
  const { dir, identity, store } = await session(cmd)
  try {
    console.log(render.me({
      id: shortId(identity.publicKey),
      profile: loadProfile(dir),
      stats: store.stats(),
      relay: relayStatus(dir)
    }))
  } finally {
    await store.close()
  }
}

async function showRelay (cmd) {
  applyColour(cmd)
  console.log(render.relayReport(relayStatus(dirFor(cmd))))
}

// The body of the background process. Phase 7 spawns this detached.
async function foregroundRelay (cmd) {
  const { dir, identity, store } = await session(cmd)
  const lock = holdLock(dir)
  if (lock === null) {
    console.log(render.relayReport(relayStatus(dir)))
    await store.close()
    return
  }

  await store.purge()

  if (cmd.flags.say) {
    const profile = loadProfile(dir) || { name: shortId(identity.publicKey), zone: 'unknown' }
    await store.put(create({ name: profile.name, status: 'ok', note: cmd.flags.say, zone: profile.zone }, identity))
    console.log(`[store] ${cmd.flags.say}`)
  }

  const node = new Relay(store, {
    onChange: (message) => console.log(`[recv] ${message.name} (${message.pk.slice(0, 8)}): ${message.note}`)
  })
  // written before joining, because flushing discovery takes a few seconds and
  // `imok relay` should not report a live relay with an unknown pid meanwhile
  const startedAt = Date.now()
  writeState(dir, { pid: process.pid, peers: 0, startedAt })
  await node.start()
  console.log('[relay] joined the topic, waiting for peers')

  const beat = setInterval(() => {
    writeState(dir, { pid: process.pid, peers: node.peers, startedAt })
    const stats = store.stats()
    console.log(`[stat] peers=${node.peers} total=${stats.total} mine=${stats.mine} others=${stats.others}`)
  }, 2000)

  const stop = async (code) => {
    clearInterval(beat)
    await node.stop()
    await store.close()
    releaseLock(lock)
    Bare.exit(code)
  }
  process.on('SIGINT', () => stop(0))
  process.on('SIGTERM', () => stop(0))
}

// ------------------------------------------------------------------ plumbing

function dirFor (cmd) {
  const storage = cmd.flags.storage || (isDev ? null : path.join(persistent(), appName))
  return storage || path.join(os.tmpdir(), 'pear', appName)
}

function columnsFor (cmd) {
  const forced = Number(cmd.flags.columns)
  if (Number.isInteger(forced) && forced > 0) return forced
  const fromEnv = Number(process.env.COLUMNS)
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv
  try {
    if (tty.isatty(1)) return new tty.WriteStream(1).columns || render.DEFAULT_COLUMNS
  } catch {
    // not a terminal, fall through
  }
  return render.DEFAULT_COLUMNS
}

function applyColour (cmd) {
  const off = cmd.flags.colour === false || process.env.NO_COLOR
  render.setColour(!off && tty.isatty(1))
}

async function session (cmd) {
  applyColour(cmd)
  const dir = dirFor(cmd)
  const identity = await loadIdentity(dir)
  const store = await openStore(dir, { publicKey: identity.publicKey })
  startUpdater(cmd, dir)
  return { dir, identity, store }
}

function startUpdater (cmd, dir) {
  if (cmd.flags.updates === false) return
  try {
    App.spawnUpdater(dir, os.execPath(), isDev ? Bare.argv[1] : null, updateWindow(cmd.flags.updateWindow))
  } catch {
    // no updates available here; never a reason to stop the command
  }
}

async function ensureProfile (dir) {
  const existing = loadProfile(dir)
  if (existing !== null) return existing

  console.log('\nFirst run. Two questions, then never again.\n')
  const name = (await ask('  What should people call you? ')) || 'anonymous'
  const zone = (await ask('  Roughly where are you? ')) || 'unknown'
  const profile = saveProfile(dir, { name, zone })
  console.log(`\n  Saved as ${profile.name} · ${profile.zone}`)
  return profile
}

function ask (question) {
  return new Promise((resolve) => {
    process.stdout.write(question)

    const take = () => {
      const end = pending.indexOf('\n')
      if (end === -1) return null
      const line = pending.slice(0, end)
      pending = pending.slice(end + 1)
      return line.trim()
    }

    const buffered = take()
    if (buffered !== null) return resolve(buffered)
    if (closed) return resolve('')

    const done = (value) => {
      process.stdin.removeListener('data', onData)
      process.stdin.removeListener('end', onEnd)
      process.stdin.pause()
      resolve(value)
    }
    const onData = (data) => {
      pending += data.toString()
      const line = take()
      if (line !== null) done(line)
    }
    const onEnd = () => {
      closed = true
      const rest = pending.trim()
      pending = ''
      done(rest)
    }

    process.stdin.on('data', onData)
    process.stdin.on('end', onEnd)
    process.stdin.resume()
  })
}

function updateWindow (value) {
  if (value === undefined) return undefined
  const wait = Number(value)
  if (Number.isSafeInteger(wait) === false || wait < 0) {
    throw new Error('--update-window must be a non-negative integer')
  }
  return wait
}

async function runUpdater (dir, wait) {
  const app = new App({
    dir,
    app: isDev ? null : os.execPath(),
    updates: true,
    version: pkg.version,
    upgrade: pkg.upgrade,
    name: isWindows ? appName + '.exe' : appName
  })
  const output = new FileLog(path.join(dir, 'updates.log'), { maxSize: 1024 * 1024 })
  const log = new Console(output)

  app.on('updating', () => log.log('[updater] getting new update'))
  app.on('updating-delta', (delta) => log.log('[updater]', delta))
  app.on('updated', () => log.log('[updater] update complete... applying'))
  app.on('update-applied', () => log.log('[updater] applied update, restart to run latest version'))
  app.on('error', (err) => log.error('[app:error]', err))

  process.on('SIGHUP', () => app.exit(129))
  process.on('SIGINT', () => app.exit(130))
  process.on('SIGQUIT', () => app.exit(131))
  process.on('SIGTERM', () => app.exit(143))

  let code = 0
  try {
    await app.updater(wait)
  } catch (err) {
    log.error('[app:error]', err)
    code = 1
  }
  code = Bare.exitCode || code
  try {
    await app.exit(code)
  } finally {
    output.close()
  }
}
