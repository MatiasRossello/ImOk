# `bien` — Plan de implementación por fases

Aleph Hackathon 2026 · Pears Track · 24 horas

**Regla de oro:** no pasás de fase si el gate no está verde. Si una fase se pasa 2× del timebox, cortá y seguí con lo que tengas.

---

## Preparación del entorno de test (hacelo ANTES de la hora 0)

### Máquina A — tu máquina principal
Donde desarrollás, compilás, deployeás y seedeás.

### Máquina B — la máquina "limpia"
La necesitás sí o sí para las fases 1, 4, 5 y 10. Opciones, en orden de preferencia:

1. **Otra laptop física** (ideal — sirve para todo, incluido BLE)
2. **Una VM Linux** (VirtualBox / UTM / Multipass) — sirve para todo menos BLE
3. **Un VPS Linux barato** — sirve para install y OTA, no para "apagar el wifi"
4. **Otro usuario del sistema operativo** — el más flojo, pero al menos separa el storage

> ⚠️ La máquina B nunca debe tener el repo clonado. Su único contacto con tu app es `pear install`. Ese es exactamente el camino que va a recorrer el juez.

### Correr dos peers en la máquina A
Necesitás **dos storages separados**. Verificá el flag exacto con:

```
pear run --help
pear --menu
```

Buscá la opción de storage (algo tipo `--store <dir>` o `--tmp-store`). Anotala acá cuando la confirmes:

```
Comando peer 1: ________________________________
Comando peer 2: ________________________________
```

**Si dos procesos comparten storage, vas a ver bugs fantasma toda la noche.** Confirmá esto en la hora 0, no después.

### Lo que NO se puede testear en una sola máquina
- Que el binario corra en una máquina sin dependencias
- Que el OTA llegue a una instalación limpia
- Partición de red real (apagar el wifi)
- BLE

---

## Fase 0 — Entorno y binario
**Timebox: 60 min**

### Qué hace Claude Code
Nada todavía. Esta fase es tuya.

### Qué hacés vos
```
curl https://install.pears.com/pear.sh | sh
pear --version

git clone https://github.com/holepunchto/hello-pear-bare
cd hello-pear-bare
git checkout variant/daemon
npm install

pear touch
```

Pegá el link que devuelve `pear touch` en el campo `upgrade` de `package.json`.

> El template viene con un link placeholder y falla con `INVALID_URL` hasta que lo reemplaces. En la variante daemon ese error va a `<storage>/updates.log`, no a tu terminal.

```
npm start          # dev, updates deshabilitados
npm run make       # binario en out/<platform>-<arch>
```

### 🚦 Gate 0
- [ ] `pear --version` responde
- [ ] `npm start` corre y muestra algo
- [ ] `out/<platform>-<arch>/` tiene un binario
- [ ] El binario corre ejecutándolo directo, fuera de npm
- [ ] Anotaste el comando de storage separado

**Si el binario no compila, no tenés proyecto. Parar todo y resolver esto.**

---

## Fase 1 — Deploy, seed y OTA vacío ⭐
**Timebox: 90 min. La fase más importante de las 24 horas.**

Todavía no escribiste una línea de tu app. Eso es a propósito: **verificás la mecánica del track antes de invertir en features.**

### Qué hace Claude Code
Nada. Cambiá vos un string a mano en la fase de test.

### Qué hacés vos

**En máquina A:**
```
pear stage <canal>
pear release <canal>
pear seed <canal>
```
Anotá el link:
```
pear://_______________________________________
```

**En máquina B (limpia):**
```
pear install pear://<key>
```
Corré la app.

**Test del OTA:**
1. En A: cambiá un texto visible (el saludo, un color, lo que sea)
2. `pear stage` → `pear release` → confirmá que sigue seedeando
3. En B: **sin reinstalar nada**, volvé a correr la app
4. Debe aparecer el texto nuevo

Si el update no llega, revisá `<storage>/updates.log` en la máquina B.

### 🚦 Gate 1
- [ ] `pear install pear://<key>` funciona en la máquina B
- [ ] La app instalada corre en B
- [ ] Cambiaste un string, hiciste release, y el cambio llegó a B sin reinstalar
- [ ] Sabés dónde está `updates.log`
- [ ] Grabaste la pantalla de este test (te sirve de backup para el video)

**A partir de acá, aunque no termines nada más, tenés una entrada válida.** Todo lo demás es mejora.

---

## Fase 2 — Identidad y firma
**Timebox: 60 min**

### Qué construye Claude Code
- Generación de keypair persistente en el storage de Pear (`hypercore-crypto`)
- `firmar(mensaje, secretKey)` → firma
- `verificar(mensaje, firma, publicKey)` → bool
- Un ID corto legible derivado de la pubkey (para mostrar en pantalla)

### Qué hacés vos
Pedile que escriba primero los tests, después la implementación.

### 🚦 Gate 2 — una sola máquina
- [ ] Corrés la app dos veces y la pubkey es la misma (persistió)
- [ ] Firmás un mensaje y verifica en el mismo proceso
- [ ] **Modificás un byte del mensaje y la verificación falla**
- [ ] Firmás con una clave y verificás con otra: falla

El tercer punto es el que importa. Si no falla, la firma es decorativa.

---

## Fase 3 — Mensaje y store local
**Timebox: 90 min**

### Qué construye Claude Code

Modelo congelado (no lo cambies después):
```
{
  v: 1,
  nombre:  string, máx 40 chars
  estado:  "bien" | "ayuda"
  nota:    string, máx 80 chars
  zona:    string, máx 40 chars
  ts:      timestamp
  pk:      pubkey del emisor
  sig:     firma
}
```

- Serialización con **tope duro de bytes** — rechazar lo que se pase
- `id` = hash del mensaje (dedup gratis)
- Store local persistente
- TTL de 72 h, purga al arrancar
- Rechazo de mensajes con firma inválida **antes** de guardarlos

### Qué hacés vos
Verificá que el tope de bytes esté implementado como validación real, no como comentario.

### 🚦 Gate 3 — una sola máquina
- [ ] Creás un mensaje, cerrás la app, la abrís, sigue ahí
- [ ] Insertás el mismo mensaje dos veces: queda uno solo
- [ ] Insertás un mensaje con firma corrupta: se rechaza
- [ ] Insertás un mensaje con `nota` de 500 chars: se rechaza
- [ ] Insertás un mensaje con `ts` de hace 4 días: se purga

---

## Fase 4 — Sincronización entre peers ⭐
**Timebox: 2 h. El corazón técnico.**

### Qué construye Claude Code
- Hyperswarm, topic global fijo (hash de un string constante)
- Al conectar: intercambio de IDs → cálculo de diferencia → envío de faltantes
- Verificación de firma de todo lo que entra, siempre
- Contador de peers conectados

### Qué hacés vos
Nada manual, pero **este es el punto donde más te va a alucinar el modelo**. Revisá que use `hyperswarm` y no invente APIs.

### 🚦 Gate 4a — una sola máquina, dos terminales
- [ ] Peer 1 y peer 2 con **storages distintos**
- [ ] Se ven: ambos muestran "1 peer conectado"
- [ ] Escribís en 1, aparece en 2
- [ ] Escribís en 2, aparece en 1
- [ ] Matás el peer 2, lo levantás: recibe lo que se perdió

### 🚦 Gate 4b — dos máquinas
- [ ] A y B se descubren en la misma red
- [ ] Mensaje de A llega a B
- [ ] **A y B en redes distintas** (una en wifi, otra en datos del celular): se siguen viendo por el DHT

El último punto es el que demuestra que es P2P de verdad y no LAN.

---

## Fase 5 — Store-and-forward (la mula) ⭐
**Timebox: 90 min. Esta es LA idea.**

### Qué construye Claude Code
- Cada peer reenvía **todos** los mensajes que carga, no solo los propios
- Contador visible: "llevás N mensajes de otras personas"
- Límite de mensajes en tránsito (protección contra flood)

### Qué hacés vos
Vos armás el escenario de test. Es manual y vale oro.

### 🚦 Gate 5a — una sola máquina, tres terminales
Este test simula el salto sin que nadie se mueva.

1. Levantá el peer **A** solo. Escribí un mensaje.
2. Levantá el peer **B**. Esperá a que sincronicen. B debe decir "llevás 1 mensaje ajeno".
3. **Matá el peer A.**
4. Levantá el peer **C**.
5. C debe recibir el mensaje de A.

- [ ] C recibió el mensaje de A, con A apagado
- [ ] La firma de A verifica en C aunque el mensaje pasó por B
- [ ] B muestra correctamente cuántos mensajes ajenos carga

### 🚦 Gate 5b — dos máquinas
- [ ] Escribís en A, apagás A, B (la otra máquina) sigue teniendo el mensaje
- [ ] Reinstalás A desde cero y B le devuelve el mensaje original

**Si el gate 5a pasa, el concepto está validado al 100%.** Todo lo demás es interfaz.

---

## Fase 6 — CLI y estados honestos
**Timebox: 2 h**

### Qué construye Claude Code
```
bien                    manda "estoy bien"
bien ayuda              manda "necesito ayuda"
bien ver                el padrón
bien ver <nombre>       buscar
bien yo                 tu identidad
```

Los tres estados, y **solo** estos tres:
```
● Guardado en tu dispositivo
● Propagado a N peers
● Salió a internet vía N gateways
```

Render ANSI a mano sobre `bare-tty`. Repintado completo con debounce de ~50 ms.

### Qué hacés vos
**Revisá personalmente que en ningún lado diga "entregado", "enviado" o aparezca un tilde verde de recepción.** Este es el punto donde el modelo va a querer poner un ✓ por costumbre de UI. No lo permitas.

### 🚦 Gate 6 — una sola máquina
- [ ] Los cinco comandos responden
- [ ] Sin peers conectados: empty state que **explica qué está pasando**, no pantalla en blanco
- [ ] En ningún estado se afirma que el mensaje llegó a destino
- [ ] Terminal en 80 columnas: no se rompe el layout
- [ ] Ctrl+C sale limpio, sin dejar el proceso colgado

---

## Fase 7 — Forma de proceso (daemon)
**Timebox: 60 min**

Esto es lo que el juez evalúa explícitamente como "process shape".

### Qué construye Claude Code
- `bien` retorna al instante; el relay sigue de fondo
- El daemon carga y reparte mensajes mientras vos hacés otra cosa
- `bien estado` para ver si el daemon está vivo

### Qué hacés vos
⚠️ **Verificá primero si podés colgar tu relay del daemon del updater o si necesitás uno propio.** Preguntale a un mentor en el Telegram. No lo descubras a las 3 AM.

### 🚦 Gate 7
- [ ] `time bien` retorna en menos de 1 segundo
- [ ] Cerrás la terminal y el daemon sigue vivo
- [ ] Otro peer que aparece después recibe tus mensajes sin que abras nada
- [ ] El daemon no queda zombie tras reiniciar la máquina

---

## Fase 8 — Salida a internet (opcional)
**Timebox: 60 min. Saltala si vas justo.**

### Qué construye Claude Code
- Rol de gateway: si un peer tiene conexión, publica los mensajes que carga
- Marcador visible de que el mensaje salió

### 🚦 Gate 8
- [ ] Con un gateway corriendo, los mensajes aparecen fuera de la red de peers
- [ ] Sin gateway, la app sigue funcionando normal (nunca es requisito)

---

## Fase 9 — BLE (opcional, upside puro)
**Timebox duro: 45 min. Si no anda, se abandona sin culpa.**

### Qué hacés vos primero
Chequeá si `ble-swarm` carga en Bare **antes de diseñar nada alrededor**. Si depende de un binding nativo de Node, no vas a poder compilar el binario y la rama muere ahí.

### 🚦 Gate 9 — dos máquinas físicas
- [ ] Con wifi apagado en ambas, se descubren
- [ ] Un mensaje viaja de una a otra
- [ ] Si el BLE falla, la app cae de vuelta a Hyperswarm **en silencio**

---

## Fase 10 — Entrega ⭐
**Timebox: 2 h. No la comprimas.**

### Qué hacés vos

**README:**
- [ ] Qué construiste y qué problema resuelve
- [ ] **De qué branch arrancaste** (`variant/daemon`) — es requisito explícito
- [ ] Por qué esa forma de proceso encaja: el relay de fondo *es* el producto
- [ ] Limitaciones honestas: sin garantía de entrega, identidad débil, padrón público, **no es alerta temprana**
- [ ] Link `pear://`

**Binarios:**
- [ ] `npm run make` para las plataformas que tengas
- [ ] Listá cuáles son, sin inflar

**Video** (mostrando las dos cosas obligatorias):
1. `pear install pear://<key>` completo, sin cortes
2. Tres terminales, wifi apagado
3. Ana escribe → "sin conexión · guardado"
4. Beto recibe → "llevás 1 mensaje ajeno"
5. **Matás a Ana en cámara**
6. Caro aparece, prende wifi, sale el mensaje de Ana
7. `pear release` con el estado "necesito ayuda" → aparece en las tres sin reinstalar

El paso 5 es el que hace que se entienda. Sin él parece un chat.

**Seed vivo:**
- [ ] Un nodo tuyo corriendo con un mensaje de bienvenida firmado
- [ ] Sleep desactivado, cargador enchufado
- [ ] Segundo nodo seedeando por las dudas
- [ ] Todo esto vivo desde las 13:00 del domingo, por 4+ horas

### 🚦 Gate 10 — el test final
En una máquina que nunca vio el repo:
- [ ] `pear install pear://<key>` funciona
- [ ] La app arranca y **muestra algo interesante estando sola** (tu mensaje de bienvenida)
- [ ] Un release nuevo llega sin reinstalar

Ese es literalmente el camino del juez. Recorrelo vos primero.

---

## Presupuesto de tiempo

| Fase | Timebox | Acumulado |
|---|---|---|
| 0 Entorno | 1 h | 1 h |
| 1 Deploy + OTA | 1.5 h | 2.5 h |
| 2 Firma | 1 h | 3.5 h |
| 3 Mensaje + store | 1.5 h | 5 h |
| 4 Sync | 2 h | 7 h |
| 5 Mula | 1.5 h | 8.5 h |
| 6 CLI | 2 h | 10.5 h |
| 7 Daemon | 1 h | 11.5 h |
| — Dormir | 5 h | 16.5 h |
| 8 Gateway | 1 h | 17.5 h |
| 9 BLE | 0.75 h | 18.25 h |
| 10 Entrega | 2 h | 20.25 h |

Quedan ~3.5 h de buffer sobre 24. Vas a usarlas todas.

---

## Puntos de corte

Si a la hora indicada no pasaste el gate, cortá esa rama y seguí:

| Hora | Si no pasaste... | Hacé esto |
|---|---|---|
| 3 | Gate 1 (OTA) | **Todo el hackathon depende de esto.** Mentor, ya |
| 9 | Gate 4 (sync) | Entregá una versión local con firma y padrón manual |
| 11 | Gate 5 (mula) | Entregá el chat sincronizado sin store-and-forward |
| 19 | Gate 9 (BLE) | Abandonar sin culpa, el README ya dice "transporte pluggable" |

---

## La única regla que no se negocia

**El deploy y el OTA van primero, con la app diciendo "hola mundo".**

El error clásico de este track es construir la app hermosa y dejar el `pear install` para las últimas dos horas. Si esa parte falla, la entrada no cuenta, por más bueno que sea el código.
