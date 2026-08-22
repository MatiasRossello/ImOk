# Im ok — project link

**Keep this. You need it four times: `pear stage`, `pear seed`, the READMEs, and the hackathon submission form.**

```
pear://zgw4h81xyucy7ehxb5cqw5rmyrtpgbqnhsnfoscp3yci1xy3kxko
```

Key only: `zgw4h81xyucy7ehxb5cqw5rmyrtpgbqnhsnfoscp3yci1xy3kxko`

Generated with `pear touch`. It is also the `upgrade` field in `package.json`, which is
what the updater daemon polls for OTA updates.

> The Phase 0 link (`p7pn1ba...`) is dead: its secret key is not in this machine's Pear
> keychain, so `pear stage` answers `Destination must be writable`. Nothing had ever been
> staged to it, so nothing was lost. This link replaced it.

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
  --win32-x64-app    ./out/win32-x64/imok.exe

pear stage pear://zgw4h81xyucy7ehxb5cqw5rmyrtpgbqnhsnfoscp3yci1xy3kxko /tmp/pear-deploy
pear seed  pear://zgw4h81xyucy7ehxb5cqw5rmyrtpgbqnhsnfoscp3yci1xy3kxko   # must stay running
```

On the clean machine, which must never have seen this repo:

```sh
curl https://install.pears.com/pear.sh | sh
pear install pear://zgw4h81xyucy7ehxb5cqw5rmyrtpgbqnhsnfoscp3yci1xy3kxko
imok
```

Pear 3.2.0 has no `pear release`: the plan was written against an older CLI. `pear build`
plus `pear stage` plus a live `pear seed` is the whole publish path now.

A seed has to be alive for anyone to install. The drive holds every platform, about
390 MB, but a peer only pulls its own binary: an install measured 78 MB downloaded.

## Platforms published

darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-x64. Not win32-arm64.
