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

## Commands

```sh
pear stage pear://zgw4h81xyucy7ehxb5cqw5rmyrtpgbqnhsnfoscp3yci1xy3kxko .
pear seed  pear://zgw4h81xyucy7ehxb5cqw5rmyrtpgbqnhsnfoscp3yci1xy3kxko   # must stay running
pear install pear://zgw4h81xyucy7ehxb5cqw5rmyrtpgbqnhsnfoscp3yci1xy3kxko   # on machine B
```

Pear 3.2.0 has no `pear release`: the plan was written against an older CLI. Staging plus a
live `pear seed` is the whole publish path now.
