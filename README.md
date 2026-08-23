# imok

_Español: [readmeES.md](docs/readmeES.md)_

Team:
- Ignacio Wuilloud
- Mateo De Luca
- Matias Rossello

> Peer-to-peer check-ins that survive the sender going offline.

`imok` is a CLI. You write that you are ok, or that you need help, and the signed
message is stored on your machine and on the machine of anyone you cross paths
with. If you run out of battery, out of signal or out of machine, the message
keeps travelling: other people carry it.

```
pear://zgw4h81xyucy7ehxb5cqw5rmyrtpgbqnhsnfoscp3yci1xy3kxko
```

Built for the Aleph Hackathon 2026 · Pears Track, on top of the
[`hello-pear-bare`](https://github.com/holepunchto/hello-pear-bare) template,
branch **`variant/daemon`**.

---

## Table of contents

- [The problem](#the-problem)
- [The idea](#the-idea)
- [Stack](#stack)
- [Install](#install)
- [Usage](#usage)
- [How it works](#how-it-works)
  - [Identity](#identity)
  - [Message](#message)
  - [Store](#store)
  - [Sync](#sync)
  - [The relay](#the-relay)
  - [Transports](#transports)
  - [Bluetooth on macOS](#bluetooth-on-macos)
  - [OTA updates](#ota-updates)
- [Project layout](#project-layout)
- [Development](#development)
- [Publishing](#publishing)
- [Honest limitations](#honest-limitations)

---

## The problem

When something breaks — a quake, a blackout, a storm, a dead zone — the first
question is always the same: _are they ok?_

And that is exactly when nothing works. WhatsApp needs the internet. An SMS needs
a tower. Every check-in app needs a server to reach. They all share one flaw:
**the message only exists while you are able to send it**. If your phone dies
right after you type "I'm ok", that "I'm ok" dies with it.

The worst case is not having no signal. It is having signal for _five seconds_,
handing the message to someone standing next to you, and having that someone walk
to where the network is. No app does that, because they all assume the sender is
alive until the server confirms.

## The idea

Store and forward. Every device carries everyone else's messages.

1. You write your check-in. It is signed with your key and stored **locally**.
2. Any peer that shows up — over the internet or over Bluetooth — takes a copy.
3. That peer forwards it to whoever it meets next. **It is not their message, and
   they carry it anyway.**
4. You can turn your machine off. The message no longer depends on you.

The ed25519 signature is what keeps this from being a game of telephone: anyone
can carry your message, nobody can alter it or invent one in your name.

The background relay **is** the product. The CLI is just the window you use to
talk to it.

## Stack

The whole runtime is [Holepunch](https://holepunch.to). No server, no backend, no
database hosted anywhere.

| Piece                                                                                                        | What for                                                                                          |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| [Bare](https://github.com/holepunchto/bare)                                                                  | JavaScript runtime. Not Node: `bare-fs`, `bare-path`, `bare-process`, `bare-pipe`, `bare-tty`, `bare-os` |
| [Pear](https://docs.pears.com)                                                                               | P2P distribution and OTA updates over a `pear://` link                                            |
| [`pear-runtime`](https://github.com/holepunchto/pear-runtime)                                                | The updater itself                                                                                |
| [`bare-daemon`](https://github.com/holepunchto/bare-daemon)                                                  | Detached processes: the updater and the relay                                                     |
| [Hyperswarm](https://github.com/holepunchto/hyperswarm)                                                      | Peer discovery and connection over the DHT, with hole punching                                    |
| [`ble-swarm`](https://github.com/holepunchto/ble-swarm)                                                      | The same swarm, over Bluetooth LE, for when there is no network                                   |
| [Hypercore / Corestore / Hyperbee](https://github.com/holepunchto/hyperbee)                                  | Local append-only persistence with a B-tree index                                                 |
| [`hypercore-crypto`](https://github.com/holepunchto/hypercore-crypto)                                        | ed25519: keypair, signing, verification, hashing                                                  |
| [`b4a`](https://github.com/holepunchto/b4a)                                                                  | Portable buffers (there is no `Buffer` in Bare)                                                   |
| [`paparam`](https://github.com/holepunchto/paparam)                                                          | Argument parsing                                                                                  |
| [`fs-native-extensions`](https://github.com/holepunchto/fs-native-extensions)                                | Advisory file locks, which is how a live relay is detected                                        |
| [`bare-build`](https://github.com/holepunchto/bare-build)                                                    | Standalone binaries, cross-compiled, for all six platforms                                        |
| [brittle](https://github.com/holepunchto/brittle) + [lunte](https://github.com/holepunchto/lunte) + prettier | Tests, lint, formatting                                                                           |

**No UI dependencies.** The ANSI rendering is written by hand in `lib/render.js`
— table, peer meter and column widths for emoji and CJK included — because
`chalk`, `ink` and `blessed` do not run on Bare, and because a native dependency
would make the standalone binary impossible.

## Install

### From the Pear link (the real path)

On a machine that has never seen this repo:

```sh
curl https://install.pears.com/pear.sh | sh
pear install pear://zgw4h81xyucy7ehxb5cqw5rmyrtpgbqnhsnfoscp3yci1xy3kxko
imok
```

`pear install` only pulls the binary for your platform (~78 MB out of the ~390 MB
the full drive holds). **It requires a live `pear seed` on the other side**:
with no peer serving the drive there is nowhere to download from.

Published platforms: all six — `darwin-arm64`, `darwin-x64`, `linux-arm64`,
`linux-x64`, `win32-x64`, `win32-arm64`.

### From the repo

```sh
npm install
npm start                      # dev run, no updates
npm run make                   # standalone binary in out/<platform>-<arch>/
```

Requires `npm` (Node.js) and the `pear` CLI (`npx pear`).

## Usage

Five commands. The first one is the one you do not type.

```sh
imok                        # check in: I'm ok
imok alert "no signal"      # check in: I need help
imok list [text]            # everything this device is carrying
imok list --watch           # the live roster, repainted as check-ins arrive
imok list --limit 50        # how many rows to draw (default 10, 0 for all)
imok me                     # your identity, your stats, your relay
imok relay                  # is the background relay running?
imok relay --watch          # live view of who is in range and how they got here
imok relay --stop           # take it down
```

The first run asks two things and never asks again:

```
First run. Two questions, then never again.

  What should people call you? Ana
  Roughly where are you? Mendoza

  Saved as Ana · Mendoza
```

A check-in:

```
 ___  _  __  __    ___   _  __
|_ _|( )|  \/  |   / _ \ | |/ /
 | | |/ | |\/| |  | | | || ' <
|___|   |_|  |_|   \___/ |_|\_\

I'm ok.

● Saved on your device
● Relayed to 3 peers
```

And when nobody is around, it says so without lying:

```
● Saved on your device
● Relayed to 0 peers

  No peers in range yet. Your relay keeps looking, and this
  goes out the moment one turns up. Nothing was thrown away.
```

The roster:

```
WHO             STATE  WHEN      ZONE           NOTE
Ana             ▲ help just now  Mendoza        no signal at the pass
Ana             ● ok   just now  Mendoza        all good
Matias Rossello ● ok   2m ago    Mendoza, Arge… all good
Mateo D         ▲ help 11m ago   Mendoza        PRUEBA BT
```

And your own state:

```
CUF99HQT
Ana · Mendoza

Carrying 87 check-ins: 2 yours, 85 from other people
Written by 9 people

Relay: running (pid 56311), 3 peers in range, up 7s
  0 nearby over Bluetooth
  3 over the network
Bluetooth: waiting
Version: 1.4.0
```

Flags shared by every command: `--storage <dir>`, `--no-updates`,
`--update-window <ms>`, `--columns <n>`, `--no-colour`.

## How it works

```
  imok (ephemeral process)                 relay (background process, one per storage)
  ┌────────────────────┐   unix socket    ┌──────────────────────────────────┐
  │ parses, asks,      │ ───────────────▶ │  Hyperbee  ← the only opener     │
  │ signs, prints,     │ ◀─────────────── │  Hyperswarm ─── peers over DHT   │
  │ dies               │   relay.sock     │  ble-swarm  ─── peers over radio │
  └────────────────────┘                  └──────────────────────────────────┘
```

### Identity

`lib/identity.js`. A 32-byte seed in `identity.key`, mode `0600`, which yields a
deterministic ed25519 keypair. It is created on the first run and never touched
again: if the file is corrupt the program **refuses to continue** instead of
generating a new one, because that would silently change your identity and orphan
every message you ever signed.

The short ID (`CUF99HQT`) is the first 40 bits of the public key in base32 with no
`0`, `O`, `1` or `I`, so it survives being read out over the phone.

`verify()` never throws. It runs on every message arriving from the network; any
garbage is `false`, not a crash.

### Message

`lib/message.js`. A one-line JSON object, capped at 512 bytes:

```json
{
  "v": 1,
  "name": "Ana",
  "status": "ok",
  "note": "all good",
  "zone": "Mendoza",
  "ts": 1755880000000,
  "pk": "…",
  "sig": "…"
}
```

The signature covers a serialized array with a fixed field order, not the object.
That makes it independent of key insertion order, which is what lets two peers
compute the same `id` (hash of the payload) for the same content. The `id` is the
deduplication unit of the whole system.

`validate()` checks in this order, on purpose: shape → limits → time window →
signature. The signature goes last because it is the expensive one and the cheap
checks have already thrown out almost all the garbage. Limits: name 40 B, note
80 B, zone 40 B, clock tolerance 5 min, TTL 72 h.

### Store

`lib/store.js`. Hyperbee over Corestore is the durable copy; an in-memory `Map`
rebuilt on open is the working index. With the 5000-message cap the whole store
weighs ~2.5 MB, so keeping it in RAM makes ordering, filtering and eviction free.

Quotas: 5000 messages total, **50 per author**, so a flooding peer cannot fill
anyone else's store. At the cap the oldest is evicted. Expired ones are purged
hourly.

`put()` validates before anything else, and it is the only way into the store.
There is no other.

### Sync

`lib/sync.js`. Symmetric anti-entropy: both sides run the same code over the same
connection, there is no client and no server.

```
  -> hello { v }         protocol version
  -> have  { ids }       everything I hold, mine and other people's alike
  <- want  { ids }       what you are missing
  -> msg   { m }         one message per line
```

One JSON line per frame; `JSON.stringify` escapes `\n` inside strings, so a note
with a line break cannot break the framing. 8 KB cap per line, `have` in chunks of
200 ids. An unknown verb is ignored, so a newer peer can add one without breaking
the old ones.

Forwarding is what does the mule work: when a new message arrives, the relay
announces it to **every other connected peer except the one that told it**.

### The relay

`lib/relay.js`, the largest file in the project, and the heart of it.

Only one process can hold the store open. While the relay runs, that process is
the relay. That is why every command talks over the local socket (`lib/ipc.js`)
instead of opening the store, and only opens it itself when there is no relay to
ask — and in that case it hands ownership over on the way out: store first, relay
second, never both at once (`lib/client.js`).

**The relay's liveness comes from an advisory lock, not from a pid in a file.** If
you kill it with `-9`, the operating system drops the lock for you, so a stale
file is never mistaken for a live process. A reboot is the same case: that is why
a relay never comes back as a zombie.

Three possible states, and all three are reported as they are:

- `relay` — one is alive and answering
- `local` — there is none; this command opens the store and starts one on the way
  out
- `unreachable` — the lock is held but nobody answers (starting up or dying). The
  store is not touched and the failure is reported. **Nothing pretends the write
  happened.**

### Transports

Two, in parallel and with the same keypair, so a peer known over either path is
recognizably the same peer:

- **Hyperswarm**, over a fixed global topic (`hash('imok:v1:global')`). Fixed on
  purpose in v1: either everyone meets in the same place, or the network
  partitions for no good reason.
- **BLE** via `ble-swarm`, which is what keeps working with wifi off. It starts
  before the network and does not depend on it. While there are DHT peers it
  scans calmly; when there are none it is the only way out and it goes hunting.

`gatt` is used instead of `l2cap` on purpose: l2cap is several times faster, but a
check-in is 512 bytes at most and gatt behaves the same on every platform.

`imok me` shows how each peer got here, which is the only way to see from inside
the app that the offline path is the one doing the work.

### Bluetooth on macOS

This cost a full day, so it is worth writing down.

macOS grants Bluetooth **to an app, not to a binary**. A process whose
`Info.plist` does not declare `NSBluetoothAlwaysUsageDescription` is killed by TCC
the instant it opens CoreBluetooth: SIGABRT, nothing on stdout, nothing in the
log. A standalone Bare binary has no `Info.plist` at all, so the radio never came
up and two people standing next to each other never saw one another.

`lib/macapp.js` builds a minimal `.app` inside the storage, with the string in the
plist and `LSUIElement` so it is a background agent (no Dock, no Cmd-Tab, no menu
bar), copies the binary inside, and launches the relay with `/usr/bin/open -n -a`,
which is the only thing that makes LaunchServices read the plist. The bundle is
rebuilt when the binary changes, so an OTA does not leave the old version running
forever.

If the bundle does not come up — machine policy, LaunchServices refusing it, a
cold start that is too slow — a plain relay is started with `--no-ble`. A relay
with no radio carrying check-ins over the network beats a machine with no relay.

### OTA updates

`app.js`, exactly as it comes from the template. Every foreground command spawns a
detached updater with `bare-daemon` and dies; the updater waits out the window
(30 s by default), queries the `upgrade` link from `package.json` over the DHT,
and if there is a new version it downloads and applies it. An `updater.lock`
guarantees one per storage.

The log lives in `<storage>/updates.log`. The relay's, in `<storage>/relay.log`.

Default storage: `persistent()` from `bare-storage` + `imok`. In dev,
`/tmp/imok-dev` via the `./imok` wrapper.

## Project layout

```
bin.mjs                    entrypoint, commands, prompts, plumbing
app.js                     updater daemon (from the template)
lib/
  identity.js              persistent keypair, signing, verification, short id
  message.js               create / encode / validate / sign — no I/O
  profile.js               name and zone, asked once
  store.js                 Hyperbee + index, dedup, TTL, quotas — no network
  sync.js                  anti-entropy protocol over one connection
  relay.js                 the daemon: lock, swarm, forward, lifecycle
  ipc.js                   unix socket / named pipe, one line per request
  client.js                relay | local | unreachable
  render.js                all the ANSI, pure functions, testable without a TTY
  macapp.js                the minimal .app that gets the permission out of macOS
  transport/ble.js         ble-swarm, and null when there is no radio
test/                      94 tests, 448 asserts
scripts/make.js            build target selector
```

Two style rules the code follows everywhere: **pure logic does not touch the
network** (`message.js` and `store.js` import nothing from transport), and **every
network error is swallowed and logged, never takes the process down**.

## Development

```sh
npm install
npm start                  # bare bin.mjs --no-updates
npm test                   # 94 tests with brittle-bare
npm run lint               # prettier --check && lunte
npm run format             # prettier --write
npm run make               # binary for your platform
npm run make:linux-x64     # or any of the six targets, cross-compiles fine
```

Wrappers for testing without typing the long flags:

```sh
./imok list                          # throwaway storage in /tmp/imok-dev
IMOK_STORAGE=/tmp/other ./imok me    # another storage, another peer
./peer ana "I'm ok"                  # a relay in the foreground, with its own storage
./peer beto                          # another one, that only carries
```

Two peers on the same machine need **separate storages**. If they share one, you
will be chasing ghost bugs all night.

To test the offline path without two machines: `--no-swarm` runs the relay on
Bluetooth alone.

## Publishing

`pear install` reads `by-arch/<platform>/app/<name>` from the drive, so staging the
source tree is not enough and never installs. **The artifact is the compiled
binary.**

```sh
npm run make:darwin-arm64      # and whichever other targets you want

pear build --target /tmp/pear-deploy --package ./package.json \
  --darwin-arm64-app ./out/darwin-arm64/imok \
  --darwin-x64-app   ./out/darwin-x64/imok \
  --linux-arm64-app  ./out/linux-arm64/imok \
  --linux-x64-app    ./out/linux-x64/imok \
  --win32-x64-app    ./out/win32-x64/imok.exe \
  --win32-arm64-app  ./out/win32-arm64/imok.exe

pear stage pear://zgw4h81xyucy7ehxb5cqw5rmyrtpgbqnhsnfoscp3yci1xy3kxko /tmp/pear-deploy
pear seed  pear://zgw4h81xyucy7ehxb5cqw5rmyrtpgbqnhsnfoscp3yci1xy3kxko   # must stay running
```

Pear 3.2.0 has no `pear release`. `pear build` + `pear stage` + a live `pear seed`
is the whole publish path today. See [PEAR-LINK.md](docs/PEAR-LINK.md).

## Honest limitations

This matters more than the feature list.

- **No delivery guarantee.** Nobody acknowledges anything. If no peer shows up,
  the message stays on your machine — and the app tells you so in those words.
- **This is not an early warning system.** It calls nobody, it makes no sound, it
  wakes nobody up. It is a roster that travels.
- **Identity is weak.** The signature proves two messages come from the same key,
  not that the key is who it claims to be. There is no directory, no verification,
  no recovery: lose `identity.key` and that identity is gone.
- **The roster is public.** Every peer that connects receives every message you
  are carrying, with name, zone and note. There is no content encryption and no
  recipients: indiscriminate forwarding is precisely the mechanism.
- **The zone is free text.** There is no GPS, and "Mendoza" is what the person
  typed, not something verified.
- **One global topic.** Everyone on the same network. It does not scale to many
  people and it is not meant to.
- **72 h TTL.** After that the message is purged everywhere.
- **Bluetooth only on macOS, iOS and Android**, which is what `bare-bluetooth`
  binds. Everywhere else the app runs the same and falls back to Hyperswarm
  silently.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
