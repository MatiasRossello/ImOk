# Im ok — project link

**Keep this. You need it four times: `pear stage`, `pear seed`, the READMEs, and the hackathon submission form.**

```
pear://phwgcr6uk1frfmwcmgxjzr5ho4mw9gog98e6omi4s7y9e7yigeto
```

Key only: `phwgcr6uk1frfmwcmgxjzr5ho4mw9gog98e6omi4s7y9e7yigeto`

Generated with `pear touch`. It is also the `upgrade` field in `package.json`, which is
what the updater daemon polls for OTA updates.

> Two earlier links are dead and must not be used. The Phase 0 link (`p7pn1ba...`) never
> had anything staged to it: its secret key is not in this machine's Pear keychain, so
> `pear stage` answers `Destination must be writable`. The v0.1.x link (`zgw4h81...`) does
> hold real builds up to 0.1.4, but v1.0.0 was published as a fresh app on the link above,
> so nothing installed from `zgw4h81...` will ever see a 1.x update.

## Publishing

`pear install` reads `by-arch/<platform>/app/<name>` out of the drive, so staging the
source tree is not enough and never installs. The artifact is the compiled binary.

```sh
npm run make                       # host platform only
npm run make:linux-x64             # or any of the six targets, cross-compiles fine

pear build --target /tmp/pear-deploy --package ./package.json \
  --darwin-arm64-app ./out/darwin-arm64/imok \
  --darwin-x64-app   ./out/darwin-x64/imok \
  --linux-arm64-app  ./out/linux-arm64/imok \
  --linux-x64-app    ./out/linux-x64/imok \
  --win32-x64-app    ./out/win32-x64/imok.exe \
  --win32-arm64-app  ./out/win32-arm64/imok.exe

pear stage pear://phwgcr6uk1frfmwcmgxjzr5ho4mw9gog98e6omi4s7y9e7yigeto /tmp/pear-deploy
pear seed  pear://phwgcr6uk1frfmwcmgxjzr5ho4mw9gog98e6omi4s7y9e7yigeto   # must stay running
```

On the clean machine, which must never have seen this repo:

```sh
curl https://install.pears.com/pear.sh | sh
pear install pear://phwgcr6uk1frfmwcmgxjzr5ho4mw9gog98e6omi4s7y9e7yigeto
imok
```

Pear 3.2.0 has no `pear release`: the plan was written against an older CLI. `pear build`
plus `pear stage` plus a live `pear seed` is the whole publish path now.

A seed has to be alive for anyone to install. The drive holds every platform, about
461 MB, but a peer only pulls its own binary: 79 MB on an ARM Mac.

## Platforms published

All six, as of v1.0.0: darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-x64,
win32-arm64.

## Published versions

| Version | Drive length | Link                                                              |
| ------- | ------------ | ----------------------------------------------------------------- |
| 1.0.0   | 8            | `pear://0.8.phwgcr6uk1frfmwcmgxjzr5ho4mw9gog98e6omi4s7y9e7yigeto` |

The versioned link pins an exact checkout; the bare link always resolves to the latest.
