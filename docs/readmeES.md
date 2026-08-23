# imok

_English: [README.md](../README.md)_

> Check-ins peer to peer que sobreviven a que el emisor se quede sin conexión.

`imok` es una CLI. Escribís que estás bien, o que necesitás ayuda, y el mensaje
firmado queda guardado en tu máquina y en la de cualquiera que se te haya
cruzado. Si te quedás sin batería, sin señal o sin máquina, el mensaje sigue
viajando: lo llevan los otros.

```
pear://zgw4h81xyucy7ehxb5cqw5rmyrtpgbqnhsnfoscp3yci1xy3kxko
```

Construido para el Aleph Hackathon 2026 · Pears Track, a partir del template
[`hello-pear-bare`](https://github.com/holepunchto/hello-pear-bare), branch
**`variant/daemon`**.

---

## Índice

- [El problema](#el-problema)
- [La idea](#la-idea)
- [Tecnologías](#tecnologías)
- [Instalación](#instalación)
- [Uso](#uso)
- [Cómo funciona](#cómo-funciona)
  - [Identidad](#identidad)
  - [Mensaje](#mensaje)
  - [Store](#store)
  - [Sincronización](#sincronización)
  - [El relay](#el-relay)
  - [Transportes](#transportes)
  - [Bluetooth en macOS](#bluetooth-en-macos)
  - [Actualizaciones OTA](#actualizaciones-ota)
- [Estructura del proyecto](#estructura-del-proyecto)
- [Desarrollo](#desarrollo)
- [Publicar](#publicar)
- [Limitaciones honestas](#limitaciones-honestas)

---

## El problema

Cuando algo se corta —un temblor, un corte de luz, una tormenta, una zona sin
cobertura— la primera pregunta es siempre la misma: _¿está bien?_

Y justo ahí es cuando nada funciona. WhatsApp necesita internet. Un SMS necesita
una antena. Cualquier app de check-in necesita un servidor al que llegar. Todas
comparten el mismo defecto: **el mensaje solo existe mientras vos podés
emitirlo**. Si tu teléfono muere después de escribir "estoy bien", ese "estoy
bien" muere con él.

El caso peor no es no tener señal. Es tener señal _cinco segundos_, mandar el
mensaje a alguien que está al lado tuyo, y que después ese alguien camine hasta
donde sí hay red. Eso ninguna app lo hace, porque todas asumen que el emisor
sigue vivo hasta que el servidor confirma.

## La idea

Store and forward. Cada dispositivo lleva encima los mensajes de los demás.

1. Escribís tu check-in. Se firma con tu clave y se guarda **local**.
2. Cualquier peer que aparezca —por internet o por Bluetooth— se lo lleva.
3. Ese peer lo reenvía a los que se cruce después. **No es tu mensaje, y lo
   lleva igual.**
4. Vos podés apagar la máquina. El mensaje ya no depende de vos.

La firma ed25519 es lo que hace que esto no sea un teléfono descompuesto:
cualquiera puede llevar tu mensaje, nadie puede modificarlo ni inventar uno a
tu nombre.

El relay de fondo **es** el producto. La CLI es solo la ventana para hablarle.

## Tecnologías

Todo el runtime es del stack [Holepunch](https://holepunch.to). No hay servidor,
no hay backend, no hay base de datos alojada en ningún lado.

| Pieza                                                                                                        | Para qué                                                                                                   |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| [Bare](https://github.com/holepunchto/bare)                                                                  | Runtime JavaScript. No es Node: `bare-fs`, `bare-path`, `bare-process`, `bare-pipe`, `bare-tty`, `bare-os` |
| [Pear](https://docs.pears.com)                                                                               | Distribución P2P y actualizaciones OTA sobre un link `pear://`                                             |
| [`pear-runtime`](https://github.com/holepunchto/pear-runtime)                                                | El updater propiamente dicho                                                                               |
| [`bare-daemon`](https://github.com/holepunchto/bare-daemon)                                                  | Procesos desprendidos: el updater y el relay                                                               |
| [Hyperswarm](https://github.com/holepunchto/hyperswarm)                                                      | Descubrimiento y conexión de peers por DHT, con hole punching                                              |
| [`ble-swarm`](https://github.com/holepunchto/ble-swarm)                                                      | El mismo swarm, pero sobre Bluetooth LE, para cuando no hay red                                            |
| [Hypercore / Corestore / Hyperbee](https://github.com/holepunchto/hyperbee)                                  | Persistencia local append-only con índice B-tree                                                           |
| [`hypercore-crypto`](https://github.com/holepunchto/hypercore-crypto)                                        | ed25519: keypair, firma, verificación, hashing                                                             |
| [`b4a`](https://github.com/holepunchto/b4a)                                                                  | Buffers portables (no existe `Buffer` en Bare)                                                             |
| [`paparam`](https://github.com/holepunchto/paparam)                                                          | Parseo de argumentos                                                                                       |
| [`fs-native-extensions`](https://github.com/holepunchto/fs-native-extensions)                                | Locks de archivo avisorios, que es cómo se sabe si hay un relay vivo                                       |
| [`bare-build`](https://github.com/holepunchto/bare-build)                                                    | Binarios standalone, cross-compilados, para las seis plataformas                                           |
| [brittle](https://github.com/holepunchto/brittle) + [lunte](https://github.com/holepunchto/lunte) + prettier | Tests, lint, formato                                                                                       |

**Sin dependencias de UI.** El render ANSI está escrito a mano en `lib/render.js`
—incluida la tabla, el medidor de peers y el ancho de columna para emoji y CJK—
porque `chalk`, `ink` y `blessed` no corren en Bare y porque una dependencia
nativa haría imposible el binario standalone.

## Instalación

### Desde el link Pear (el camino real)

En una máquina que nunca vio este repo:

```sh
curl https://install.pears.com/pear.sh | sh
pear install pear://zgw4h81xyucy7ehxb5cqw5rmyrtpgbqnhsnfoscp3yci1xy3kxko
imok
```

`pear install` baja únicamente el binario de tu plataforma (~78 MB de los ~390 MB
que tiene el drive completo). **Requiere que haya un `pear seed` vivo del otro
lado**: sin un peer sirviendo el drive no hay de dónde bajar.

Plataformas publicadas: las seis — `darwin-arm64`, `darwin-x64`, `linux-arm64`,
`linux-x64`, `win32-x64`, `win32-arm64`.

### Desde el repo

```sh
npm install
npm start                      # corre en dev, sin updates
npm run make                   # binario standalone en out/<platform>-<arch>/
```

Requiere `npm` (Node.js) y la CLI `pear` (`npx pear`).

## Uso

Cinco comandos. El primero es el que no se escribe.

```sh
imok                        # check in: estoy bien
imok alert "sin señal"      # check in: necesito ayuda
imok list [texto]           # todo lo que este dispositivo está llevando
imok list --watch           # el padrón en vivo, repintado cuando llega algo
imok list --limit 50        # cuántas filas mostrar (default 10, 0 son todas)
imok me                     # tu identidad, tus estadísticas, tu relay
imok relay                  # ¿está corriendo el relay de fondo?
imok relay --watch          # vista viva de quién está en rango y por dónde llegó
imok relay --stop           # bajarlo
```

La primera vez pregunta dos cosas y no vuelve a preguntar nunca:

```
First run. Two questions, then never again.

  What should people call you? Ana
  Roughly where are you? Mendoza

  Saved as Ana · Mendoza
```

Un check-in:

```
 ___  _  __  __    ___   _  __
|_ _|( )|  \/  |   / _ \ | |/ /
 | | |/ | |\/| |  | | | || ' <
|___|   |_|  |_|   \___/ |_|\_\

I'm ok.

● Saved on your device
● Relayed to 3 peers
```

Y cuando no hay nadie cerca, lo dice sin mentir:

```
● Saved on your device
● Relayed to 0 peers

  No peers in range yet. Your relay keeps looking, and this
  goes out the moment one turns up. Nothing was thrown away.
```

El padrón:

```
WHO             STATE  WHEN      ZONE           NOTE
Ana             ▲ help just now  Mendoza        no signal at the pass
Ana             ● ok   just now  Mendoza        all good
Matias Rossello ● ok   2m ago    Mendoza, Arge… all good
Mateo D         ▲ help 11m ago   Mendoza        PRUEBA BT
```

Y tu estado:

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

Flags comunes a todos los comandos: `--storage <dir>`, `--no-updates`,
`--update-window <ms>`, `--columns <n>`, `--no-colour`.

## Cómo funciona

```
  imok (proceso efímero)                   relay (proceso de fondo, uno por storage)
  ┌────────────────────┐   unix socket    ┌──────────────────────────────────┐
  │ parsea, pregunta,  │ ───────────────▶ │  Hyperbee  ← el único que la abre│
  │ firma, imprime,    │ ◀─────────────── │  Hyperswarm ─── peers por DHT    │
  │ se muere           │   relay.sock     │  ble-swarm  ─── peers por radio  │
  └────────────────────┘                  └──────────────────────────────────┘
```

### Identidad

`lib/identity.js`. Un seed de 32 bytes en `identity.key`, modo `0600`, del que
sale un keypair ed25519 determinístico. Se crea en el primer run y no se toca
nunca más: si el archivo está corrupto el programa **se niega a seguir** en vez
de generar uno nuevo, porque eso te cambiaría la identidad en silencio y dejaría
huérfano cada mensaje que firmaste.

El ID corto (`CUF99HQT`) son los primeros 40 bits de la clave pública en base32
sin `0`, `O`, `1` ni `I`, para que sobreviva a ser dictado por teléfono.

`verify()` nunca tira excepción. Corre sobre cada mensaje que llega de la red;
cualquier basura es `false`, no un crash.

### Mensaje

`lib/message.js`. Un objeto JSON de una línea, con tope de 512 bytes:

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

La firma cubre un array serializado con orden de campos fijo, no el objeto. Eso
lo hace independiente del orden de inserción de claves, que es lo que permite
que dos peers calculen el mismo `id` (hash del payload) para el mismo contenido.
El `id` es la unidad de deduplicación de todo el sistema.

`validate()` chequea en este orden, a propósito: forma → límites → ventana
temporal → firma. La firma va última porque es la cara y las baratas ya
descartaron casi toda la basura. Límites: nombre 40 B, nota 80 B, zona 40 B,
tolerancia de reloj 5 min, TTL 72 h.

### Store

`lib/store.js`. Hyperbee sobre Corestore es la copia durable; un `Map` en memoria
reconstruido al abrir es el índice de trabajo. Con el tope de 5000 mensajes el
store entero pesa ~2.5 MB, así que tenerlo en RAM regala orden, filtro y
desalojo gratis.

Cuotas: 5000 mensajes en total, **50 por autor**, para que un peer que inunda no
llene el store de nadie. Al llegar al tope se desaloja el más viejo. Los
expirados se purgan cada hora.

`put()` valida antes que nada, y es la única entrada al store. No hay otra.

### Sincronización

`lib/sync.js`. Anti-entropía simétrica: los dos lados corren el mismo código
sobre la misma conexión, no hay cliente ni servidor.

```
  -> hello { v }         versión de protocolo
  -> have  { ids }       todo lo que tengo, mío y ajeno por igual
  <- want  { ids }       lo que a vos te falta
  -> msg   { m }         un mensaje por línea
```

Una línea JSON por frame; `JSON.stringify` escapa los `\n` dentro de strings, así
que una nota con salto de línea no puede romper el framing. Tope de 8 KB por
línea, `have` en chunks de 200 ids. Un verbo desconocido se ignora, para que un
peer más nuevo pueda agregar uno sin romper a los viejos.

El reenvío es lo que hace la mula: cuando llega un mensaje nuevo, el relay se lo
anuncia a **todos los demás peers conectados menos al que se lo contó**.

### El relay

`lib/relay.js`, el archivo más grande del proyecto, y el corazón.

Solo un proceso puede tener el store abierto. Mientras el relay corre, ese
proceso es el relay. Por eso cada comando habla por el socket local
(`lib/ipc.js`) en vez de abrir el store, y solo lo abre él mismo cuando no hay
relay a quien preguntarle —y en ese caso cede la propiedad al cerrar: primero el
store, después el relay, nunca los dos a la vez (`lib/client.js`).

**La vida del relay sale de un lock avisorio, no de un pid en un archivo.** Si lo
matás con `-9`, el sistema operativo suelta el lock por vos, así que un archivo
viejo nunca se confunde con un proceso vivo. Un reboot es el mismo caso: por eso
un relay nunca vuelve como zombi.

Tres estados posibles, y los tres se dicen tal cual son:

- `relay` — hay uno vivo y contesta
- `local` — no hay ninguno, este comando abre el store y arranca uno al salir
- `unreachable` — el lock está tomado pero nadie contesta (arrancando o
  muriendo). No se toca el store y se dice que no se pudo. **Nada finge que la
  escritura ocurrió.**

### Transportes

Dos, en paralelo y con el mismo keypair, así un peer conocido por cualquiera de
los dos caminos es reconociblemente el mismo peer:

- **Hyperswarm**, sobre un topic global fijo (`hash('imok:v1:global')`). Fijo a
  propósito en v1: o todos se encuentran en el mismo lugar, o la red se
  particiona sin ninguna buena razón.
- **BLE** vía `ble-swarm`, que es lo que sigue funcionando con el wifi apagado.
  Arranca antes que la red y no depende de ella. Mientras hay peers por DHT
  escanea con calma; cuando no hay ninguno, es la única salida y sale a cazar.

Se usa `gatt` y no `l2cap` a propósito: l2cap es varias veces más rápido, pero
un check-in tope 512 bytes y gatt se comporta igual en todas las plataformas.

`imok me` muestra por dónde llegó cada peer, que es la única forma de ver desde
adentro de la app que el camino offline es el que está haciendo el trabajo.

### Bluetooth en macOS

Esto costó un día entero, así que vale la pena contarlo.

macOS le da el Bluetooth **a una app, no a un binario**. Un proceso cuyo
`Info.plist` no declara `NSBluetoothAlwaysUsageDescription` lo mata TCC en el
instante en que abre CoreBluetooth: SIGABRT, nada en stdout, nada en el log. Un
binario standalone de Bare no tiene `Info.plist` en absoluto, así que la radio
nunca levantaba y dos personas paradas una al lado de la otra nunca se veían.

`lib/macapp.js` arma un `.app` mínimo dentro del storage, con el string en el
plist y `LSUIElement` para que sea un agente de fondo (sin Dock, sin Cmd-Tab, sin
barra de menú), copia el binario adentro, y lanza el relay con
`/usr/bin/open -n -a`, que es lo único que hace que LaunchServices lea el plist.
El bundle se rehace cuando el binario cambia, para que un OTA no quede corriendo
la versión vieja para siempre.

Si el bundle no levanta —política de la máquina, LaunchServices que lo rechaza,
arranque en frío demasiado lento— se arranca un relay común con `--no-ble`. Un
relay sin radio que lleva check-ins por la red le gana a una máquina sin relay.

### Actualizaciones OTA

`app.js`, tal como viene del template. Cada comando en primer plano dispara un
updater desprendido con `bare-daemon` y se muere; el updater se queda esperando
la ventana (30 s por defecto), consulta el link `upgrade` del `package.json` por
el DHT, y si hay versión nueva la baja y la aplica. Un `updater.lock` garantiza
uno solo por storage.

El log está en `<storage>/updates.log`. El del relay, en `<storage>/relay.log`.

Storage por defecto: el `persistent()` de `bare-storage` + `imok`. En dev,
`/tmp/imok-dev` vía el wrapper `./imok`.

## Estructura del proyecto

```
bin.mjs                    entrypoint, comandos, prompts, plumbing
app.js                     daemon del updater (del template)
lib/
  identity.js              keypair persistente, firma, verificación, id corto
  message.js               crear / codificar / validar / firmar — sin I/O
  profile.js               nombre y zona, preguntados una vez
  store.js                 Hyperbee + índice, dedup, TTL, cuotas — sin red
  sync.js                  protocolo anti-entropía sobre una conexión
  relay.js                 el daemon: lock, swarm, forward, ciclo de vida
  ipc.js                   unix socket / named pipe, una línea por request
  client.js                relay | local | unreachable
  render.js                todo el ANSI, funciones puras, testeables sin TTY
  macapp.js                el .app mínimo que le saca el permiso a macOS
  transport/ble.js         ble-swarm, y null cuando no hay radio
test/                      94 tests, 448 asserts
scripts/make.js            selector de target de build
```

Dos reglas de estilo que el código respeta en todos lados: **la lógica pura no
toca la red** (`message.js` y `store.js` no importan nada de transporte), y
**todo error de red se traga y se loguea, nunca tumba el proceso**.

## Desarrollo

```sh
npm install
npm start                  # bare bin.mjs --no-updates
npm test                   # 94 tests con brittle-bare
npm run lint               # prettier --check && lunte
npm run format             # prettier --write
npm run make               # binario para tu plataforma
npm run make:linux-x64     # o cualquiera de los seis targets, cross-compila bien
```

Wrappers para probar sin escribir los flags largos:

```sh
./imok list                          # storage descartable en /tmp/imok-dev
IMOK_STORAGE=/tmp/otro ./imok me     # otro storage, otro peer
./peer ana "estoy bien"              # un relay en primer plano, con su storage
./peer beto                          # otro, que solo lleva
```

Dos peers en la misma máquina necesitan **storages separados**. Si comparten uno,
vas a ver bugs fantasma toda la noche.

Para probar el camino offline sin dos máquinas: `--no-swarm` corre el relay solo
con Bluetooth.

## Publicar

`pear install` lee `by-arch/<platform>/app/<name>` del drive, así que stagear el
código fuente no alcanza y nunca instala. **El artefacto es el binario
compilado.**

```sh
npm run make:darwin-arm64      # y los demás targets que quieras

pear build --target /tmp/pear-deploy --package ./package.json \
  --darwin-arm64-app ./out/darwin-arm64/imok \
  --darwin-x64-app   ./out/darwin-x64/imok \
  --linux-arm64-app  ./out/linux-arm64/imok \
  --linux-x64-app    ./out/linux-x64/imok \
  --win32-x64-app    ./out/win32-x64/imok.exe \
  --win32-arm64-app  ./out/win32-arm64/imok.exe

pear stage pear://zgw4h81xyucy7ehxb5cqw5rmyrtpgbqnhsnfoscp3yci1xy3kxko /tmp/pear-deploy
pear seed  pear://zgw4h81xyucy7ehxb5cqw5rmyrtpgbqnhsnfoscp3yci1xy3kxko   # tiene que quedar corriendo
```

Pear 3.2.0 no tiene `pear release`. `pear build` + `pear stage` + un `pear seed`
vivo es todo el camino de publicación hoy. Ver [PEAR-LINK.md](PEAR-LINK.md).

## Limitaciones honestas

Esto importa más que la lista de features.

- **No hay garantía de entrega.** Nadie confirma nada. Si no aparece ningún peer,
  el mensaje se queda en tu máquina —y la app te lo dice con esas palabras.
- **No es un sistema de alerta temprana.** No llama a nadie, no suena, no
  despierta a nadie. Es un padrón que viaja.
- **La identidad es débil.** La firma prueba que dos mensajes son de la misma
  clave, no que esa clave sea quien dice ser. No hay directorio, no hay
  verificación, no hay recuperación: si perdés `identity.key`, perdiste esa
  identidad.
- **El padrón es público.** Todo peer que se conecte recibe todos los mensajes
  que llevás, con nombre, zona y nota. No hay cifrado de contenido ni
  destinatarios: el reenvío indiscriminado es precisamente el mecanismo.
- **La zona es texto libre.** No hay GPS, y "Mendoza" es lo que la persona
  escribió, no algo verificado.
- **Un topic global.** Todos en la misma red. No escala a mucha gente y no está
  pensado para eso.
- **TTL de 72 h.** Después de eso el mensaje se purga en todos lados.
- **Bluetooth solo en macOS, iOS y Android**, que es lo que `bare-bluetooth`
  bindea. En el resto la app corre igual y se cae a Hyperswarm en silencio.

## Licencia

Apache-2.0. Ver [LICENSE](../LICENSE) y [NOTICE](../NOTICE).
