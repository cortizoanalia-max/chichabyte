# Chichabyte — versión standalone

Esta versión corre como una app propia, fuera de Claude, en cualquier navegador.
La diferencia con la versión anterior es que ahora hay un **servidor propio**
que guarda tus llaves y habla con Anthropic y Airtable por vos — el navegador
nunca ve esas llaves.

```
chichabyte-app/
  server.js        ← el servidor (sin dependencias externas)
  public/
    index.html      ← la interfaz que ves en el navegador
```

## 1. Requisitos

Necesitás **Node.js 18 o más nuevo** instalado en tu computadora.
Para chequear: abrí una terminal y corré `node -v`. Si no lo tenés,
descargalo de https://nodejs.org (versión LTS).

## 2. Conseguí las dos llaves

**Anthropic API key**
1. Entrá a https://console.anthropic.com
2. Settings → API Keys → Create Key
3. Copiala (empieza con `sk-ant-...`)

**Airtable Personal Access Token**
1. Entrá a https://airtable.com/create/tokens
2. Create new token
3. Dale acceso a la base "Gastos Viaje - App Compras" (o la que uses)
4. Scopes necesarios: `data.records:read` y `data.records:write`
5. Copiá el token (empieza con `pat...`)

## 3. Configurá las llaves

Abrí `server.js` con cualquier editor de texto y completá estas tres líneas
al principio del archivo:

```js
const CONFIG = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "sk-ant-TU-LLAVE-ACA",
  AIRTABLE_TOKEN:     process.env.AIRTABLE_TOKEN     || "pat-TU-TOKEN-ACA",
  AIRTABLE_BASE_ID:   process.env.AIRTABLE_BASE_ID   || "appGuGZs2b4KREXFw",
  ...
```

(Si preferís no dejar las llaves escritas en el archivo, podés en cambio
definirlas como variables de entorno antes de arrancar el servidor —
`export ANTHROPIC_API_KEY=sk-ant-...` en Mac/Linux, o `set` en Windows —
y dejar el resto tal cual.)

## 4. Arrancalo

En una terminal, parado en la carpeta `chichabyte-app`:

```
node server.js
```

Vas a ver:
```
Chichabyte corriendo en http://localhost:3000
```

Abrí esa dirección en tu navegador. Listo — ya podés subir tickets,
analizarlos y guardarlos en Airtable, sin depender de Claude para nada de eso.

## 5. Si querés que quede accesible desde cualquier lado (no solo tu compu)

Podés desplegar esta misma carpeta en un servicio gratuito o económico como
Render, Railway o Fly.io — todos soportan Node.js sin configuración especial.
El proceso general es: creás una cuenta, conectás el repositorio o subís la
carpeta, definís las variables de entorno `ANTHROPIC_API_KEY`,
`AIRTABLE_TOKEN` y `AIRTABLE_BASE_ID` en el panel del servicio (en vez de
escribirlas en el archivo), y el comando de arranque es `node server.js`.

## 6. Usarlo desde el celular (útil en viaje)

Para esto necesitás que el servidor no corra solo en tu compu, sino en un lugar
accesible desde internet. El camino más simple sin usar la terminal para nada
de esto es GitHub (para guardar el código) + Render (para que quede corriendo):

### A. Subí el código a GitHub (sin usar git por consola)

1. Creá una cuenta gratis en https://github.com si no tenés.
2. Arriba a la derecha, ícono "+" → "New repository". Nombralo `chichabyte`,
   dejalo en **Private** si preferís, y creá el repositorio.
3. Dentro del repo vacío, click en "uploading an existing file" (o
   "Add file" → "Upload files").
4. Arrastrá ahí las tres cosas de esta carpeta: `server.js`, `README.md` y la
   carpeta `public` completa (con `index.html`, `manifest.json`, `sw.js`,
   `icon-192.png`, `icon-512.png`).
5. Click en "Commit changes" (el botón verde) para guardar.

**Importante:** no subas tus API keys pegadas en `server.js`. Dejalas como
están (los placeholders `PEGA_ACA_...`) — las vas a poner en el paso
siguiente, en el panel de Render, no en el código.

### B. Publicalo en Render

1. Creá una cuenta gratis en https://render.com (podés entrar con tu cuenta
   de GitHub directamente).
2. Dashboard → "New" → "Web Service".
3. Conectá el repositorio `chichabyte` que acabás de subir.
4. Configuración:
   - **Runtime:** Node
   - **Build Command:** dejalo vacío (no hay nada que instalar)
   - **Start Command:** `node server.js`
   - **Instance type:** Free
5. Bajá hasta "Environment Variables" y agregá las tres:
   - `ANTHROPIC_API_KEY` → tu llave de Anthropic
   - `AIRTABLE_TOKEN` → tu token de Airtable
   - `AIRTABLE_BASE_ID` → `appGuGZs2b4KREXFw` (o la base que uses)
6. "Create Web Service". Esperá unos minutos al primer deploy.

Cuando termine te da una URL pública tipo `https://chichabyte.onrender.com` —
esa es tu app, accesible desde cualquier lado, celular incluido.

*(El plan gratis de Render "duerme" el servidor después de 15 minutos sin uso,
así que la primera carga del día puede tardar 30-60 segundos en despertar.
Es normal, no es que se rompió.)*

### C. Instalala como ícono en el celular

Una vez que tenés la URL pública andando:

- **Android (Chrome):** abrí la URL, tocá el menú (⋮) → "Instalar app" o
  "Agregar a pantalla principal". Va a aparecer con el ícono de Chichabyte
  como cualquier otra app.
- **iPhone (Safari):** abrí la URL, tocá el botón de compartir (el cuadrado
  con la flecha hacia arriba) → "Agregar a pantalla de inicio".

A partir de ahí la abrís tocando el ícono, sin escribir la URL cada vez, y
ocupa toda la pantalla como una app nativa.

## Notas

- Los IDs de tabla y campo en `server.js` corresponden a la base
  "Gastos Viaje - App Compras" tal como está hoy. Si agregás/renombrás
  campos en Airtable, actualizá el bloque `FIELDS` en `server.js`.
- El campo `Total` (y `Precio` en Gastos) es moneda fija en euros en esa
  base — el servidor solo lo completa cuando el ticket está en EUR; para
  el resto de las monedas usá `Monto_Original` / `Total_USD` (o
  `Precio_Original` / `Precio_USD`).
- Cada gasto que uses en la API de Anthropic (lectura del ticket + búsqueda
  de cotización) consume créditos de tu cuenta — no es gratis, a diferencia
  de usar Claude directamente en el chat.
