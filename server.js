// Chichabyte — backend standalone (motor gratuito: Google Gemini)
// Corre con: node server.js
// Sin dependencias externas (usa el fetch y http nativos de Node 18+).
//
// Completá las dos llaves de abajo, o definilas como variables de entorno
// con el mismo nombre (GEMINI_API_KEY, AIRTABLE_TOKEN) — las variables de
// entorno tienen prioridad si existen.

const CONFIG = {
  GEMINI_API_KEY:     process.env.GEMINI_API_KEY     || "PEGA_ACA_TU_API_KEY_DE_GOOGLE_AI_STUDIO",
  AIRTABLE_TOKEN:      process.env.AIRTABLE_TOKEN     || "PEGA_ACA_TU_PERSONAL_ACCESS_TOKEN_DE_AIRTABLE",
  AIRTABLE_BASE_ID:    process.env.AIRTABLE_BASE_ID   || "appGuGZs2b4KREXFw",
  PORT:                process.env.PORT || 3000,
};

// Modelo gratuito de Gemini usado para leer el ticket. Si en el futuro Google
// cambia los nombres de modelo, este es el único lugar que hay que tocar.
const GEMINI_MODEL = "gemini-2.5-flash";

const TABLES = {
  tickets: "tblmGV81NIi5FEyyH",
  gastos:  "tblZKCGYl0WXbNLkx",
};

// IDs de campo tal como están hoy en la base "Gastos Viaje - App Compras".
const FIELDS = {
  tickets: {
    comercio: "fldBPz95aUix5YbpB",
    fecha: "fldWlrorDSevHaEJa",
    total: "fldHWq1iuYSYdIU4x",           // currency fijo en EUR — solo se usa si moneda == EUR
    categoriaPrincipal: "fldCaW2mrLzOwoluC",
    notas: "fldou1LkcBtEtffSl",
    monedaOriginal: "fldyziI58GNwsyGIG",
    montoOriginal: "fldiwqMiqBAxAZyRG",
    tasaUsd: "fldvlyzgSpj5hPsUM",
    totalUsd: "fld2s3pPR7bBYfK8o",
  },
  gastos: {
    producto: "fldyf6mI18B7lX5NI",
    precio: "fldNfHc1YYFTcmODt",           // currency fijo en EUR — no se usa para otras monedas
    cantidad: "fldqjewW7dUuingDN",
    categoria: "fldNTL6akanKwbK7W",
    fecha: "fldoinwY5Ddx4ftkH",
    ticket: "fld3vBVlt14OlLnj7",
    monedaOriginal: "fldo6ejZOAy5PWgfy",
    precioOriginal: "fldv0Ip4E5KACEws1",
    precioUsd: "fld2xJT9NDVWe1mjf",
  },
};

const CATS = ["Alimentación","Transporte","Alojamiento","Vestimenta","Ocio","Salud","Otros"];

const http = require("http");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------- helpers

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function parseModelJSON(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const a = clean.indexOf("{");
  const b = clean.lastIndexOf("}");
  if (a < 0 || b < 0) throw new Error("El modelo no devolvió JSON legible.");
  return JSON.parse(clean.slice(a, b + 1));
}

// -------------------------------------------------------- Gemini (gratis)

async function geminiVision(prompt, imageBase64, mime) {
  if (!CONFIG.GEMINI_API_KEY || CONFIG.GEMINI_API_KEY.startsWith("PEGA_ACA")) {
    throw new Error("Falta configurar GEMINI_API_KEY en server.js (o como variable de entorno).");
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${CONFIG.GEMINI_API_KEY}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mime, data: imageBase64 } },
        ],
      }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
    }),
  });
  const data = await r.json();
  if (!r.ok) {
    const msg = data?.error?.message || r.status;
    if (r.status === 429) throw new Error("Se agotó la cuota gratuita de Gemini por hoy (o por minuto). Esperá un poco y probá de nuevo.");
    throw new Error("Gemini API: " + msg);
  }
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("\n") || "";
  if (!text) throw new Error("Gemini no devolvió texto (puede haber bloqueado la imagen por seguridad).");
  return text;
}

async function extractTicket(imageBase64, mime) {
  const prompt = `Extraés datos de tickets de compra. Respondé SOLO con un objeto JSON válido, sin markdown, sin backticks y sin texto antes o después.

Esquema exacto:
{
 "comercio": string,
 "lugar": string,
 "fecha": "YYYY-MM-DD" o null si no se ve,
 "numero_ticket": string o null,
 "moneda": código ISO de 3 letras (EUR, UYU, USD, ARS, BRL, GBP...),
 "items": [{"producto":string,"cantidad":number,"precio_unitario":number,"total_linea":number,"categoria":string}],
 "subtotal": number o null,
 "descuento": number (positivo, 0 si no hay),
 "total": number,
 "categoria_principal": string,
 "notas": string
}

Reglas:
- "categoria" y "categoria_principal" solo pueden ser: Alimentación, Transporte, Alojamiento, Vestimenta, Ocio, Salud, Otros.
- Si un producto está borroso o ilegible, poné "[ilegible]" como nombre y estimá los números que sí se lean; si tampoco se leen, poné 0.
- Si el ticket tiene un descuento global, prorrateá proporcionalmente en cada total_linea para que la suma de total_linea sea igual a "total".
- Deducí la moneda por el país, los símbolos o el impuesto (IGI→Andorra EUR, IVA+RUT→Uruguay UYU, etc.).
- "total" es el importe final efectivamente pagado.
- Los números van sin símbolos ni separadores de miles: 2662.50, no "$U 2.662,50".`;

  const text = await geminiVision(prompt, imageBase64, mime);
  return parseModelJSON(text);
}

// --------------------------------------------- cotización (sin IA, gratis)

// Cotizaciones ya buscadas: persisten en un archivo en disco para
// sobrevivir a que Render "duerma" el servicio gratuito y lo reinicie.
const RATE_CACHE_FILE = path.join(__dirname, "rate-cache.json");
function loadRateCache() {
  try { return JSON.parse(fs.readFileSync(RATE_CACHE_FILE, "utf8")); } catch { return {}; }
}
function saveRateCache(obj) {
  try { fs.writeFileSync(RATE_CACHE_FILE, JSON.stringify(obj)); } catch { /* disco de solo lectura, no pasa nada */ }
}
const rateCache = loadRateCache();

// API pública y gratuita fawazahmed0/currency-api (sin key, sin límite
// documentado, cubre 200+ monedas). Si el día exacto no tiene dato
// (fin de semana/feriado), reintenta con los días anteriores.
async function fetchRate(currency, fecha) {
  if (!currency || currency === "USD") {
    return { rate: 1, fuente: "Moneda ya expresada en dólares" };
  }
  const cur = currency.toLowerCase();
  const key = cur + "_" + (fecha || "latest");
  if (rateCache[key]) return rateCache[key];

  const tried = [];
  for (let back = 0; back <= 6; back++) {
    let dateStr = "latest";
    if (fecha) {
      const d = new Date(fecha + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() - back);
      dateStr = d.toISOString().slice(0, 10);
    } else if (back > 0) {
      break;
    }
    tried.push(dateStr);
    const url = `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${dateStr}/v1/currencies/${cur}.json`;
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const data = await r.json();
      const rate = data?.[cur]?.usd;
      if (rate && isFinite(rate) && rate > 0) {
        const result = {
          rate,
          fuente: `Cotización de mercado del ${data.date} (fawazahmed0/currency-api)` +
                   (back > 0 ? ` — ${fecha} no tenía dato publicado, se usó el hábil más cercano` : ""),
        };
        rateCache[key] = result;
        saveRateCache(rateCache);
        return result;
      }
    } catch { /* probamos la fecha siguiente */ }
  }
  throw new Error("No se encontró una cotización para " + currency.toUpperCase() + " (probé: " + tried.join(", ") + ").");
}

// ------------------------------------------------------------- Airtable

async function airtableCreate(tableId, records) {
  if (!CONFIG.AIRTABLE_TOKEN || CONFIG.AIRTABLE_TOKEN.startsWith("PEGA_ACA")) {
    throw new Error("Falta configurar AIRTABLE_TOKEN en server.js (o como variable de entorno).");
  }
  const out = [];
  for (let i = 0; i < records.length; i += 10) {
    const chunk = records.slice(i, i + 10);
    const r = await fetch(
      `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${tableId}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${CONFIG.AIRTABLE_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ records: chunk }),
      }
    );
    const data = await r.json();
    if (!r.ok) throw new Error("Airtable: " + (data?.error?.message || r.status));
    out.push(...data.records);
  }
  return out;
}

// ------------------------------------------------------------------ rutas

async function handleAnalyze(req, res) {
  const body = JSON.parse(await readBody(req));
  if (!body.image_base64 || !body.mime) return sendJSON(res, 400, { error: "Falta la imagen." });

  const t = await extractTicket(body.image_base64, body.mime);
  const fx = await fetchRate(t.moneda, t.fecha);

  t.tasa = fx.rate;
  t.fuente_tasa = fx.fuente;
  t.total_usd = +((t.total || 0) * fx.rate).toFixed(2);
  (t.items || []).forEach((i) => {
    i.usd = +((i.total_linea || 0) * fx.rate).toFixed(2);
    if (!CATS.includes(i.categoria)) i.categoria = "Otros";
  });
  if (!CATS.includes(t.categoria_principal)) t.categoria_principal = "Otros";

  sendJSON(res, 200, t);
}

async function handleSave(req, res) {
  const body = JSON.parse(await readBody(req));
  const t = body.ticket;
  if (!t) return sendJSON(res, 400, { error: "Falta el ticket." });

  const F = FIELDS.tickets;
  const ticketFields = {
    [F.comercio]: t.comercio || "Comercio sin identificar",
    [F.categoriaPrincipal]: t.categoria_principal || "Otros",
    [F.monedaOriginal]: t.moneda || "USD",
    [F.montoOriginal]: t.total || 0,
    [F.tasaUsd]: t.tasa || 1,
    [F.totalUsd]: t.total_usd || 0,
    [F.notas]:
      (t.notas ? t.notas + " " : "") +
      (t.numero_ticket ? "Ticket Nº " + t.numero_ticket + ". " : "") +
      (t.lugar ? "Lugar: " + t.lugar + ". " : "") +
      (t.fuente_tasa ? "Cotización: " + t.fuente_tasa + "." : ""),
  };
  if (t.fecha) ticketFields[F.fecha] = t.fecha;
  if (t.moneda === "EUR") ticketFields[F.total] = t.total || 0;

  const [ticketRecord] = await airtableCreate(TABLES.tickets, [{ fields: ticketFields }]);

  const G = FIELDS.gastos;
  const items = t.items || [];
  const itemRecords = items.map((i) => {
    const f = {
      [G.producto]: i.producto || "[sin nombre]",
      [G.cantidad]: i.cantidad || 1,
      [G.categoria]: CATS.includes(i.categoria) ? i.categoria : "Otros",
      [G.monedaOriginal]: t.moneda || "USD",
      [G.precioOriginal]: i.total_linea || 0,
      [G.precioUsd]: i.usd || 0,
      [G.ticket]: [ticketRecord.id],
    };
    if (t.fecha) f[G.fecha] = t.fecha;
    if (t.moneda === "EUR") f[G.precio] = i.total_linea || 0;
    return { fields: f };
  });

  let gastosRecords = [];
  if (itemRecords.length) gastosRecords = await airtableCreate(TABLES.gastos, itemRecords);

  sendJSON(res, 200, { ok: true, ticketId: ticketRecord.id, gastos: gastosRecords.length });
}

// -------------------------------------------------------------- servidor

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/analyze") return await handleAnalyze(req, res);
    if (req.method === "POST" && req.url === "/api/save") return await handleSave(req, res);

    let filePath = path.join(__dirname, "public", req.url === "/" ? "index.html" : req.url);
    if (!filePath.startsWith(path.join(__dirname, "public"))) return sendJSON(res, 403, { error: "Prohibido" });
    if (!fs.existsSync(filePath)) return sendJSON(res, 404, { error: "No encontrado" });
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    sendJSON(res, 500, { error: err.message || "Error interno" });
  }
});

server.listen(CONFIG.PORT, () => {
  console.log(`Chichabyte corriendo en http://localhost:${CONFIG.PORT}`);
  if (CONFIG.GEMINI_API_KEY.startsWith("PEGA_ACA")) console.log("⚠ Falta GEMINI_API_KEY");
  if (CONFIG.AIRTABLE_TOKEN.startsWith("PEGA_ACA")) console.log("⚠ Falta AIRTABLE_TOKEN");
});
