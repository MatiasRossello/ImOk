import { command, flag, arg, summary, description } from 'paparam'
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
import { create } from './lib/message.js'
import { connect } from './lib/client.js'
import { liveStatus, runRelay, stopRelay } from './lib/relay.js'
import * as render from './lib/render.js'

const appName = pkg.productName || pkg.name
const isDev = path.basename(Bare.argv[0], path.extname(Bare.argv[0])) === 'bare'
// Absolute, because the relay is launched through `open` on a Mac and
// LaunchServices does not inherit this process's working directory.
const entrypoint = isDev ? path.resolve(Bare.argv[1]) : null

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
  flag('--stop', 'stop the background relay'),
  flag('--watch|-w', 'live view of who is in range and how they got here'),
  flag('--foreground', 'run the relay here instead of reporting on it').hide(),
  flag('--detached', 'log to relay.log instead of this terminal').hide(),
  flag('--no-swarm', 'run the relay without joining the network').hide(),
  flag('--no-ble', 'run the relay without Bluetooth').hide(),
  flag('--say <note>', 'publish a note before relaying').hide(),
  ...common(),
  (cmd) => { run = () => relayCommand(cmd) }
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
  applyColour(cmd)
  const dir = dirFor(cmd)

  // asked before anything opens the store, because it can block on a person
  // typing and the relay wants that lock
  const profile = await ensureProfile(dir)
  const { identity, client } = await session(cmd, dir)

  let result = null
  try {
    const note = (cmd.args?.note || '').trim() || (status === 'alert' ? 'needs help' : 'all good')
    result = await client.put(create({ name: profile.name, status, note, zone: profile.zone }, identity))
  } finally {
    await client.close()
  }

  if (client.mode === 'unreachable' || result === 'unreachable') {
    return console.log(render.relayStuck(client.relay))
  }

  console.log(render.checkIn({ status, peers: client.relay.peers, reach: client.relay.reach }))
  if (client.relay.alive === false) {
    console.log(render.relayReport(client.relay, { attempted: true }).trimEnd())
    console.log()
  }
}

async function showRoster (cmd) {
  applyColour(cmd)
  const dir = dirFor(cmd)
  const { client } = await session(cmd, dir)

  let messages = []
  const who = cmd.args?.who || null
  try {
    messages = await client.list(who ? { name: who } : {})
  } finally {
    await client.close()
  }

  if (client.mode === 'unreachable') return console.log(render.relayStuck(client.relay))

  console.log(render.roster(messages, {
    columns: columnsFor(cmd),
    query: who,
    peers: client.relay.peers
  }))
}

async function showMe (cmd) {
  applyColour(cmd)
  const dir = dirFor(cmd)
  const { identity, client } = await session(cmd, dir)

  try {
    await client.refresh()
  } finally {
    await client.close()
  }

  if (client.mode === 'unreachable') return console.log(render.relayStuck(client.relay))

  console.log(render.me({
    id: shortId(identity.publicKey),
    profile: loadProfile(dir),
    stats: client.stats,
    relay: client.relay,
    version: pkg.version
  }))
}

async function relayCommand (cmd) {
  if (cmd.flags.foreground) return foregroundRelay(cmd)

  applyColour(cmd)
  const dir = dirFor(cmd)

  if (cmd.flags.stop) {
    const { stopped, pid, running } = await stopRelay(dir)
    console.log('')
    if (stopped) console.log(`Relay stopped (pid ${pid}).`)
    else if (running) console.log(`Relay (pid ${pid}) was asked to stop and has not let go yet.`)
    else console.log('No relay was running.')
    console.log('')
    return
  }

  if (cmd.flags.watch) return watchRelay(cmd, dir)

  console.log(render.relayReport(await liveStatus(dir)))
}

// Repaints the whole block on a timer. Ctrl+C has to put the cursor back or it
// stays invisible in the terminal after we are gone.
async function watchRelay (cmd, dir) {
  const started = Date.now()
  let stopping = false

  const paint = async () => {
    if (stopping) return
    const relay = await liveStatus(dir)
    if (stopping) return
    process.stdout.write(render.CLEAR + render.watch(relay, { started, columns: columnsFor(cmd) }) + '\n')
  }

  const finish = () => {
    if (stopping) return
    stopping = true
    clearInterval(timer)
    process.stdout.write(render.SHOW_CURSOR + '\n')
    Bare.exit(0)
  }

  process.on('SIGINT', finish)
  process.on('SIGTERM', finish)
  process.stdout.write(render.HIDE_CURSOR)

  await paint()
  const timer = setInterval(() => { paint().catch(() => {}) }, 1000)
}

// The body of the background process, and of `./peer` in the foreground.
async function foregroundRelay (cmd) {
  const dir = dirFor(cmd)
  const detached = cmd.flags.detached === true
  const output = detached ? new FileLog(path.join(dir, 'relay.log'), { maxSize: 1024 * 1024 }) : null
  const log = detached ? new Console(output) : console

  let node = null
  try {
    node = await runRelay(dir, {
      log,
      swarm: cmd.flags.swarm !== false,
      bluetooth: cmd.flags.ble !== false,
      say: cmd.flags.say ?? null
    })
  } catch (err) {
    log.error(`[relay] ${err.message}`)
    output?.close()
    Bare.exit(1)
  }

  if (node === null) {
    // another relay already holds the lock, which is the normal outcome of two
    // commands racing to start one
    if (detached) log.log('[relay] another relay is already running')
    else console.log(render.relayReport(await liveStatus(dir)))
    output?.close()
  }
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

async function session (cmd, dir) {
  const identity = await loadIdentity(dir)
  startUpdater(cmd, dir)
  const client = await connect(dir, {
    publicKey: identity.publicKey,
    execPath: os.execPath(),
    entrypoint
  })
  return { dir, identity, client }
}

function startUpdater (cmd, dir) {
  if (cmd.flags.updates === false) return
  try {
    App.spawnUpdater(dir, os.execPath(), entrypoint, updateWindow(cmd.flags.updateWindow))
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
