const fs = require('bare-fs')
const path = require('bare-path')
const { isMac } = require('which-runtime')

// macOS gives Bluetooth to an app, not to a binary. A process whose Info.plist
// carries no NSBluetoothAlwaysUsageDescription is killed by TCC the instant it
// opens CoreBluetooth — SIGABRT, no error on stdout, nothing in the log. A
// standalone bare binary has no Info.plist at all, so the radio never came up
// on a Mac and two people standing next to each other never met.
//
// So the relay runs out of a minimal .app that carries the string. LSUIElement
// makes it a background agent: no Dock icon, no Cmd-Tab entry, no menu bar.
// Nothing about the command line changes; this is only how the daemon gets
// launched.
const REASON =
  'imok carries check-ins to people standing near you when there is no network.'
const BUNDLE_ID = 'com.imok.relay'
const INSIDE = path.join('.app', 'Contents', 'MacOS') + path.sep

function plist (name, exe) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleName</key><string>${name}</string>
  <key>CFBundleExecutable</key><string>${exe}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
  <key>NSBluetoothAlwaysUsageDescription</key><string>${REASON}</string>
</dict>
</plist>
`
}

// Whether this process is allowed to open the radio at all. Everywhere but a
// Mac the question does not arise. On a Mac it is the difference between a
// working relay and one the system shoots on sight.
function permitted (execPath) {
  if (isMac === false) return true
  return typeof execPath === 'string' && execPath.includes(INSIDE)
}

// Builds, or refreshes, the bundle the relay is launched from. Returns its
// path, or null when this machine needs no bundle or the wrap did not work.
// Never throws: a relay that cannot be wrapped still carries check-ins over
// the network, it just has no radio.
function ensure (dir, execPath, { name = 'imok' } = {}) {
  if (isMac === false) return null
  if (typeof execPath !== 'string' || execPath === '') return null
  // already inside one, which is every relay that reaches this a second time
  if (permitted(execPath)) return execPath.slice(0, execPath.indexOf('.app') + 4)

  try {
    const app = path.join(dir, name + '.app')
    const contents = path.join(app, 'Contents')
    // Named after the binary it copies, never after the app: the entrypoint
    // check in bin.mjs reads argv[0], so a `bare` renamed to `imok` would stop
    // looking like a dev run and start parsing its own script path as a command.
    const exeName = path.basename(execPath)
    const exe = path.join(contents, 'MacOS', exeName)

    const source = fs.statSync(execPath)
    let current = null
    try {
      current = fs.statSync(exe)
    } catch {
      current = null
    }

    // An update rewrites the binary underneath us. A bundle still holding the
    // previous copy would go on running the old version for good, which is
    // exactly the failure the updater exists to prevent.
    const stale =
      current === null ||
      current.size !== source.size ||
      current.mtimeMs < source.mtimeMs

    if (stale) {
      fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true })
      try { fs.unlinkSync(exe) } catch {} // a running copy cannot be overwritten
      fs.copyFileSync(execPath, exe)
      fs.chmodSync(exe, 0o755)
    }

    fs.writeFileSync(path.join(contents, 'Info.plist'), plist(name, exeName))
    return app
  } catch {
    return null
  }
}

module.exports = { ensure, permitted, BUNDLE_ID }
