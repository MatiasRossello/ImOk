# `bien` — Especificación de implementación

Documento para alimentar a Claude Code. Cada fase tiene: entregable, contratos, restricciones y criterios de aceptación verificables.

**Regla:** una fase está terminada cuando todos sus criterios de aceptación pasan. No antes.

---

## 0. Reglas del entorno (leer antes de escribir código)

### Bare no es Node

| ❌ Nunca | ✅ Usar |
|---|---|
| `require('fs')` | `require('bare-fs')` |
| `require('path')` | `require('bare-path')` |
| `require('net')` | `require('bare-tcp')` |
| `process` de Node | `require('bare-process')` |
| `Buffer` | `b4a` |
| `os`, `crypto`, `events` de Node | `bare-os`, `hypercore-crypto`, `bare-events` |

### Librerías prohibidas
`ink`, `blessed`, `chalk`, `commander`, `yargs`, `inquirer`, cualquier paquete con bindings nativos `.node`.

Render ANSI a mano. Parseo de argv a mano.

### Prohibido inventar
Si no estás seguro de una API de Bare o Pear, **detenete y decilo**. No escribas un flag de CLI ni un método que no verificaste en la doc. Es preferible un `TODO: verificar en docs.pears.com` que código que no corre.

### Puntos a verificar en la doc antes de usarlos
- ⚠️ Flag de storage separado en `pear run` (para correr dos peers en una máquina)
- ⚠️ API exacta de `bare-tty` para raw mode y lectura de teclas
- ⚠️ Ruta de storage de la app en runtime (`Pear.config.storage` o equivalente)
- ⚠️ Si el daemon del updater admite lógica propia o hay que levantar un proceso aparte
- ⚠️ API de `ble-swarm` y si carga en Bare

### Estructura de archivos

```
bien/
  package.json
  index.js                 entrypoint + routing de comandos
  lib/
    identity.js            keypair persistente
    message.js             crear / codificar / validar / firmar / verificar
    store.js               persistencia, dedup, TTL, límites
    sync.js                protocolo anti-entropía
    relay.js               proceso de fondo: swarm + store
    render.js              salida ANSI
    transport/
      swarm.js             Hyperswarm
      ble.js               opcional, fase 9
  test/
    *.test.js
```

### Estilo
- Módulos chicos, sin I/O en la lógica pura (`message.js` y `store.js` no tocan la red)
- Todo error de red se traga y se loguea, nunca tumba el proceso
- Sin dependencias nuevas sin justificar

---

## Fase 1 — Deploy y OTA

**Sin código de aplicación.** Se despliega `hello-pear-bare` tal cual.

### Criterios de aceptación
1. `pear install pear://<key>` completa sin error en una máquina que nunca vio el repo
2. La app instalada corre y produce salida
3. Tras un `pear stage` + `pear release` con un string modificado, la máquina B muestra el string nuevo **sin reinstalar**
4. La ruta de `updates.log` está documentada en el README

---

## Fase 2 — Identidad

### Entregable: `lib/identity.js`

```js
// Carga el keypair del storage; si no existe, lo crea y persiste.
// Idempotente: dos llamadas devuelven el mismo par.
async function loadIdentity(storagePath) → { publicKey, secretKey }

// ID corto legible derivado de publicKey. 8 chars, base32 sin ambiguos (0/O, 1/l).
function shortId(publicKey) → string

// Firma ed25519 sobre bytes crudos.
function sign(bytes, secretKey) → signature

// Verificación. NUNCA tira excepción: devuelve false ante cualquier entrada inválida.
function verify(bytes, signature, publicKey) → boolean
```

### Restricciones
- `hypercore-crypto` para keypair, firma y verificación
- `secretKey` con permisos restrictivos en disco, nunca en logs ni en pantalla
- `verify` debe manejar `null`, buffers de largo incorrecto y basura sin explotar

### Criterios de aceptación
1. Dos llamadas a `loadIdentity` sobre el mismo storage devuelven la misma `publicKey`
2. Storages distintos producen `publicKey` distintas
3. `verify(bytes, sign(bytes, sk), pk) === true`
4. Modificar **un solo byte** de `bytes` → `verify === false`
5. Firmar con `skA` y verificar con `pkB` → `false`
6. `verify(null, null, null) === false` sin excepción
7. `verify(basura_aleatoria, ...)` → `false` sin excepción
8. `shortId` es determinístico y no contiene `0`, `O`, `1`, `l`
9. La `secretKey` no aparece en ninguna salida de la app

---

## Fase 3 — Mensaje y store

### Entregable: `lib/message.js`

```js
const LIMITES = {
  nombre: 40,      // bytes UTF-8
  nota: 80,
  zona: 40,
  total: 512,      // mensaje serializado completo
  futuro: 5 * 60 * 1000,        // tolerancia de reloj hacia adelante
  ttl: 72 * 60 * 60 * 1000
}
```

**Forma del mensaje:**
```js
{
  v: 1,
  nombre: string,
  estado: 'bien' | 'ayuda',
  nota: string,
  zona: string,
  ts: number,          // epoch ms
  pk: string,          // hex, 64 chars
  sig: string          // hex, 128 chars
}
```

```js
// Codificación canónica del payload firmable.
// ORDEN DE CAMPOS FIJO: v, nombre, estado, nota, zona, ts, pk. sig NO se incluye.
// Dos peers deben producir bytes idénticos para el mismo contenido.
// NO usar JSON.stringify sobre el objeto: el orden de claves no está garantizado.
function encodePayload(msg) → bytes

// id = hash(encodePayload(msg)), hex. Determina la deduplicación.
function messageId(msg) → string

// Crea y firma. Aplica límites: tira si el input excede.
function create({ nombre, estado, nota, zona }, identity) → msg

// Validación completa. Devuelve { ok: true } o { ok: false, razon: string }.
// Verifica en este orden: forma → límites → ventana temporal → firma.
function validate(msg, ahora = Date.now()) → { ok, razon }

// Serialización para la red: JSON de una línea, sin saltos internos.
function toLine(msg) → string
function fromLine(line) → msg | null    // null ante JSON inválido, nunca tira
```

### Entregable: `lib/store.js`

```js
const STORE_LIMITES = {
  total: 5000,        // mensajes en el store
  porPeer: 50         // mensajes por pubkey — anti-flood
}

async function open(storagePath) → store

// Valida antes de guardar. Devuelve 'nuevo' | 'duplicado' | 'rechazado'.
store.put(msg) → string

store.get(id) → msg | null
store.ids() → string[]                  // todos los ids, para el sync
store.list({ estado, nombre }) → msg[]  // ordenado por ts descendente
store.purge(ahora) → number             // borra vencidos, devuelve cuántos
store.stats() → { total, propios, ajenos, peers }
```

### Restricciones
- `store.put` **siempre** llama a `validate`. No hay camino que guarde sin validar.
- Al llegar a `total`, se evictan los más viejos primero
- Al llegar a `porPeer` para una pubkey, se rechazan los nuevos de esa pubkey
- Persistencia sobrevive reinicio del proceso

### Criterios de aceptación

**Codificación**
1. `encodePayload` del mismo contenido con claves en distinto orden de inserción produce bytes idénticos
2. `messageId` es determinístico
3. `fromLine('{"basura"')` → `null`, sin excepción
4. `fromLine(toLine(msg))` reconstruye un mensaje equivalente
5. `toLine` nunca contiene `\n`

**Validación**
6. Mensaje con `nota` de 500 chars → `{ ok: false }`
7. Mensaje con `nombre` de 41 bytes → `{ ok: false }`
8. Serializado de más de 512 bytes → `{ ok: false }`
9. `estado: 'cualquiera'` → `{ ok: false }`
10. `ts` de hace 73 h → `{ ok: false }`
11. `ts` 10 minutos en el futuro → `{ ok: false }`
12. `ts` 2 minutos en el futuro → `{ ok: true }`
13. Firma corrupta → `{ ok: false }`
14. Campo `nota` modificado después de firmar → `{ ok: false }`

**Store**
15. `put` de un mensaje válido → `'nuevo'`; el mismo otra vez → `'duplicado'`; `stats().total` sube en 1
16. `put` de un mensaje con firma inválida → `'rechazado'`; no queda en el store
17. Cerrar y reabrir el store: los mensajes siguen
18. 51 mensajes de la misma pubkey → el 51 es `'rechazado'`
19. `purge` con un mensaje de hace 73 h lo elimina y devuelve 1
20. `stats()` distingue correctamente propios de ajenos

---

## Fase 4 — Sincronización

### Entregable: `lib/sync.js` + `lib/transport/swarm.js`

**Protocolo.** Líneas JSON terminadas en `\n`, máximo 8 KB por línea.

```
→ HELLO  { t:'hello', v:1 }
→ HAVE   { t:'have', ids:[...] }        chunks de máx 200 ids
← WANT   { t:'want', ids:[...] }
→ MSG    { t:'msg', m:{...} }           uno por línea
```

Ambos lados ejecutan el mismo flujo, simétricamente. Sin roles de cliente/servidor.

```js
// Topic global fijo. Constante en el código, no configurable en v1.
const TOPIC = hash('bien:v1:global')

function attach(connection, store, { onCambio }) → detach
```

### Restricciones
- Todo mensaje entrante pasa por `store.put`, que valida. **No hay atajo.**
- Línea de más de 8 KB → se descarta la conexión
- `t` desconocido → se ignora la línea, no se cierra la conexión
- Datos parciales: el framing por línea debe manejar chunks partidos por TCP
- Ninguna excepción de red puede tumbar el proceso

### Criterios de aceptación

**Una máquina, dos procesos con storages distintos**
1. Ambos reportan 1 peer conectado en menos de 30 s
2. Mensaje creado en A aparece en B
3. Mensaje creado en B aparece en A
4. B se reinicia y recupera lo que se perdió mientras estaba caído
5. Ninguno acepta un mensaje con firma inválida inyectado por el otro
6. Una línea de 20 KB cierra esa conexión sin tumbar el proceso
7. Una línea con `t:'desconocido'` se ignora y la conexión sigue viva
8. Un mensaje partido en dos chunks TCP se reensambla correctamente

**Dos máquinas**
9. Se descubren en la misma red
10. **Se descubren en redes distintas** (una en wifi, otra en datos móviles)
11. Con 3 peers, un mensaje llega a los 3

---

## Fase 5 — Store-and-forward

### Entregable: cambios en `lib/sync.js` y `lib/store.js`

La regla central: **`HAVE` incluye todos los ids del store, no solo los propios.** El peer no distingue entre mensajes propios y ajenos al retransmitir.

```js
store.stats() → { total, propios, ajenos, peers }
```

### Criterios de aceptación

**Una máquina, tres procesos** — el test que valida la idea entera:
1. Levantar A, crear mensaje. `A.stats().propios === 1`
2. Levantar B, esperar sync. `B.stats().ajenos === 1`, `B.stats().propios === 0`
3. **Matar A**
4. Levantar C, esperar sync. C tiene el mensaje de A
5. En C, `validate` del mensaje de A devuelve `ok: true` — la firma sobrevivió el salto
6. La `pk` del mensaje en C es la de A, no la de B

**Dos máquinas**
7. A crea, B recibe, A se apaga: B conserva el mensaje
8. A borra su storage y reinstala: B le devuelve el mensaje original de A

**Robustez**
9. Un peer que manda 5000 mensajes basura no llena el store de los demás (límite `porPeer`)
10. Un mensaje que dio 3 saltos sigue verificando contra la pk original

---

## Fase 6 — CLI

### Entregable: `index.js` + `lib/render.js`

```
bien                     manda estado 'bien'
bien ayuda               manda estado 'ayuda'
bien ver                 padrón, ordenado por ts descendente
bien ver <texto>         filtra por nombre
bien yo                  identidad propia y stats
bien estado              salud del relay
```

Primera corrida: pide nombre y zona, los persiste.

### Los tres estados — literal, sin variantes

```
● Guardado en tu dispositivo
● Propagado a N peers
● Salió a internet vía N gateways
```

### Prohibiciones de interfaz (no negociables)

- ❌ Las palabras "entregado", "enviado", "recibido por", "llegó a"
- ❌ Tildes verdes, ✓, o cualquier marca que sugiera recepción por el destinatario
- ❌ Barras de progreso hacia un destinatario
- ✅ Solo se afirma lo que la máquina local puede verificar

### Restricciones de render
- ANSI a mano, sin librerías
- Repintado completo con debounce de 50 ms
- Leer `columns` del stdout y adaptar; mínimo 60 columnas
- Ctrl+C restaura el modo de terminal y sale con código 0

### Criterios de aceptación
1. Los seis comandos responden sin excepción
2. Primera corrida pide nombre y zona; la segunda ya no
3. Sin peers: empty state que explica el estado y sugiere una acción. **No pantalla en blanco**
4. `grep -ri "entregado\|enviado\|✓" lib/ index.js` no devuelve nada en strings de interfaz
5. Terminal en 60 columnas: no se rompe el layout
6. Terminal en 200 columnas: no se rompe el layout
7. Ctrl+C sale limpio, sin dejar la terminal en raw mode
8. `bien ver <texto>` que no matchea nada: mensaje explicativo, no lista vacía muda
9. Un nombre con emoji o acentos se renderiza y cuenta bien
10. `bien` con el relay caído: guarda igual y lo avisa

---

## Fase 7 — Daemon

### Entregable: `lib/relay.js`

```js
// Arranca si no está corriendo. Idempotente.
async function ensureRelay(storagePath) → { pid, yaEstaba }

async function relayStatus(storagePath) → { vivo, pid, peers, uptime }
```

- Lockfile con pid en el storage
- Lockfile huérfano (proceso muerto) se limpia solo
- Los comandos one-shot escriben en el store y salen; el relay propaga

### Criterios de aceptación
1. `bien` retorna en menos de 1 s
2. Tras `bien`, el relay está vivo
3. `bien` dos veces seguidas no levanta dos relays
4. Cerrar la terminal: el relay sigue vivo
5. Un peer que aparece 10 minutos después recibe los mensajes sin abrir nada
6. Matar el relay con `kill -9` y correr `bien`: detecta el lockfile huérfano y levanta uno nuevo
7. `bien estado` reporta correctamente vivo/muerto
8. El relay no consume CPU en reposo (menos de 1% sin peers)

---

## Fase 8 — Gateway (opcional)

```js
// Sale solo si hay conectividad. Marca los ids publicados.
async function publish(mensajes) → { publicados: string[] }
```

### Criterios de aceptación
1. Con gateway activo, un mensaje aparece fuera de la red de peers
2. Sin gateway, la app funciona igual — nunca es requisito
3. El gateway no republica lo ya publicado
4. Gateway sin internet: falla en silencio, no rompe el relay

---

## Fase 9 — BLE (opcional, timebox 45 min)

**Antes de escribir nada:** verificar que `ble-swarm` carga en Bare y que `npm run make` sigue produciendo binario. Si depende de un `.node` nativo, abandonar la fase.

### Entregable: `lib/transport/ble.js` con la misma interfaz que `swarm.js`

```js
async function create({ onConnection }) → transport | null   // null si no disponible
```

### Criterios de aceptación
1. Sin BLE disponible, `create` devuelve `null` y la app arranca normal
2. `npm run make` sigue produciendo binario con el módulo incluido
3. Dos máquinas físicas con wifi apagado se descubren
4. Un mensaje viaja entre ellas sin red
5. El fallback a Hyperswarm es silencioso: sin stacktrace en pantalla

---

## Fase 10 — Entrega

### Criterios de aceptación
1. `pear install pear://<key>` funciona en una máquina que nunca vio el repo
2. La app recién instalada **muestra algo interesante estando sola** — tu mensaje de bienvenida firmado
3. Un `pear release` nuevo llega a esa instalación sin reinstalar
4. El README dice qué construiste, de qué branch arrancaste (`variant/daemon`) y por qué esa forma de proceso encaja
5. El README lista las limitaciones: sin garantía de entrega, identidad débil, padrón público, **no es alerta temprana**
6. El README lista las plataformas de los binarios, sin inflar
7. El video muestra el `pear install` completo y el OTA llegando
8. Hay un nodo tuyo seedeando desde las 13:00 del domingo

---

## Tests automatizados mínimos

Escribir **antes** de la implementación de cada fase.

| Archivo | Cubre | Fase |
|---|---|---|
| `identity.test.js` | persistencia, firma, verificación, entradas basura | 2 |
| `message.test.js` | codificación canónica, límites, ventana temporal | 3 |
| `store.test.js` | dedup, TTL, límites, persistencia | 3 |
| `sync.test.js` | framing, chunks partidos, líneas inválidas | 4 |
| `forward.test.js` | tres stores en memoria, salto A→B→C | 5 |

`forward.test.js` es el más importante: valida la idea sin necesitar red ni tres terminales.

---

## Orden de trabajo con Claude Code

Por cada fase:

1. Pegar la sección de la fase, con los contratos completos
2. Pedir **primero los tests**, después la implementación
3. Correr los tests
4. Recién ahí, verificación manual
5. Commit con el número de fase
6. Pasar a la siguiente

**No pasar de fase con criterios en rojo.** El costo de arrastrar un bug de la fase 3 a la fase 5 es de horas.
