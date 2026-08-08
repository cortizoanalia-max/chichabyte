// Chichabyte — backend standalone
// Corre con: node server.js
// No tiene dependencias externas (usa el fetch y http nativos de Node 18+).
//
// Configuración: completá las tres variables de abajo, o definilas como
// variables de entorno con el mismo nombre (ANTHROPIC_API_KEY, AIRTABLE_TOKEN,
// AIRTABLE_BASE_ID) — las variables de entorno tienen prioridad si existen.

const CONFIG = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "PEGA_ACA_TU_API_KEY_DE_ANTHROPIC",
  AIRTABLE_TOKEN:     process.env.AIRTABLE_TOKEN     || "PEGA_ACA_TU_PERSONAL_ACCESS_TOKEN_DE_AIRTABLE",
  AIRTABLE_BASE_ID:   process.env.AIRTABLE_BASE_ID   || "appGuGZs2b4KREXFw",
  PORT:               process.env.PORT || 3000,
};

const TABLES = {
  tickets: "tblmGV81NIi5FEyyH",
  gastos:  "tblZKCGYl0WXbNLkx",
};

// IDs de campo tal como están hoy en la base "Gastos Viaje - App Compras".
// Si renombrás o agregás campos en Airtable, actualizá estos IDs.
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

async function anthropicMessages(body) {
  if (!CONFIG.ANTHROPIC_API_KEY || CONFIG.ANTHROPIC_API_KEY.startsWith("PEGA_ACA")) {
    throw new Error("Falta configurar ANTHROPIC_API_KEY en server.js (o como variable de entorno).");
  }
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CONFIG.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) {
    throw new Error("Anthropic API: " + (data?.error?.message || r.status));
  }
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
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

  const text = await anthropicMessages({
    model: "claude-sonnet-4-6",
    max_tokens: 4000,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mime, data: imageBase64 } },
          { type: "text", text: prompt },
        ],
      },
    ],
  });
  return parseModelJSON(text);
}

async function fetchRate(currency, fecha) {
  if (!currency || currency === "USD") {
    return { rate: 1, fuente: "Moneda ya expresada en dólares" };
  }
  const text = await anthropicMessages({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    messages: [
      {
        role: "user",
        content:
          "Buscá en la web la cotización de 1 " + currency + " expresada en dólares estadounidenses (USD) para la fecha " +
          (fecha || "más reciente disponible") + ". Si ese día el mercado estaba cerrado, usá el cierre hábil más cercano y aclaralo. " +
          'Respondé SOLO con JSON válido, sin markdown: {"rate": number, "fuente": "medio y fecha del dato"}. ' +
          '"rate" es cuántos dólares vale 1 ' + currency + " (por ejemplo si 1 USD = 40,20 UYU entonces rate = 0.0249).",
      },
    ],
    tools: [{ type: "web_search_20250305", name: "web_search" }],
  });
  const r = parseModelJSON(text);
  if (!r.rate || !isFinite(r.rate) || r.rate <= 0) {
    throw new Error("No se encontró una cotización confiable para " + currency + ".");
  }
  return r;
}

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

    // archivos estáticos desde /public
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
  if (CONFIG.ANTHROPIC_API_KEY.startsWith("PEGA_ACA")) console.log("⚠ Falta ANTHROPIC_API_KEY");
  if (CONFIG.AIRTABLE_TOKEN.startsWith("PEGA_ACA")) console.log("⚠ Falta AIRTABLE_TOKEN");
});
