/**
 * Rebuild tests/fixtures/satispay-realistic.xlsx.
 *
 * The workbook is a fully synthetic Satispay export: Italian columns, Excel
 * datetimes (UTC wall-clock, including times near midnight), Italian amount
 * text, emoji Tipo/Stato values, Buoni Pasto and FlexBen splits, one matched
 * refund, cashback, a rejected movement, and rows before 2026-10-01.
 * It contains no personal data.
 *
 *   node scripts/generate-satispay-fixture.mjs
 */
import { deflateRawSync, crc32 } from "node:zlib";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const HEADERS = [
  "Data",
  "Nome",
  "Descrizione",
  "Importo",
  "Tipo",
  "Stato",
  "Disponibilità",
  "Buoni Pasto",
  "FlexBen",
  "Disponibilità dopo la transazione",
  "ID (Comunicalo all'Assistenza Clienti in caso di problemi)",
];

const APPROVED = "✅ Approvato";
const STORE = "🏬 a un Negozio";

/** Newest first, matching a real export. Wallet balances follow the cash portion only. */
const MOVEMENTS = [
  row({
    at: "2026-10-11T07:07:07.000Z",
    name: "-",
    description: "Movimento senza nome",
    amount: "-3,00",
    type: "Altro",
    availability: "-3,00",
    balance: "1.344,56",
    id: "syn-unknown",
  }),
  row({
    at: "2026-10-10T15:00:00.000Z",
    name: "Banca Sintetica",
    description: "Bonifico in entrata",
    amount: "+1.234,56",
    type: "🏦 Bonifico Bancario in Entrata",
    availability: "+1.234,56",
    balance: "1.347,56",
    id: "syn-iban",
  }),
  row({
    at: "2026-10-09T00:30:00.000Z",
    name: "Chiosco Sintetico",
    description: "Giornale",
    amount: "-1,10",
    type: STORE,
    availability: "-1,10",
    balance: "113,00",
    id: "syn-morning-edge",
  }),
  row({
    at: "2026-10-08T10:15:00.000Z",
    name: "Negozio Rifiutato",
    description: "Pagamento non riuscito",
    amount: "-9,99",
    type: STORE,
    status: "❌ Rifiutato",
    availability: "-9,99",
    balance: "114,10",
    id: "syn-rejected",
  }),
  row({
    at: "2026-10-07T16:05:45.000Z",
    name: "Caffè Sintetico",
    description: "Rimborso pranzo",
    amount: "+20,23",
    type: "🔄 Rimborso",
    // Reported Disponibilità includes the meal-voucher portion. The balance column does not.
    availability: "+20,23",
    balance: "124,09",
    id: "syn-refund-cafe",
  }),
  row({
    at: "2026-10-06T19:40:00.000Z",
    name: "Persona Sintetica",
    description: "Compleanno",
    amount: "-15,00",
    type: "👤 a una Persona",
    availability: "-15,00",
    balance: "119,86",
    id: "syn-p2p",
  }),
  row({
    at: "2026-10-05T08:00:01.000Z",
    name: "Satispay",
    description: "Accredito punti",
    amount: "+3,39",
    type: "🎖️ Punti",
    availability: "+3,39",
    balance: "134,86",
    id: "syn-cashback",
  }),
  row({
    at: "2026-10-04T11:22:30.000Z",
    name: "Market Misto",
    description: "Spesa mista",
    amount: "-30,00",
    type: STORE,
    availability: "-10,00",
    meal: "-12,00",
    flex: "-8,00",
    balance: "131,47",
    id: "syn-mixed",
  }),
  row({
    at: "2026-10-03T18:20:04.000Z",
    name: "Palestra Sintetica",
    description: "Abbonamento FlexBen",
    amount: "-25,00",
    type: STORE,
    flex: "-25,00",
    balance: "141,47",
    id: "syn-flex-only",
  }),
  row({
    at: "2026-10-02T12:10:00.000Z",
    name: "Trattoria Sintetica",
    description: "Pasto solo buoni",
    amount: "-8,00",
    type: STORE,
    meal: "-8,00",
    balance: "141,47",
    id: "syn-meal-only",
  }),
  row({
    at: "2026-10-01T00:05:00.000Z",
    name: "Panificio Sintetico",
    description: "Cornetto",
    amount: "-1,80",
    type: STORE,
    availability: "-1,80",
    balance: "141,47",
    id: "syn-after-midnight",
  }),
  row({
    at: "2026-09-30T23:50:00.000Z",
    name: "Edicola Sintetica",
    description: "Rivista",
    amount: "-2,5",
    type: STORE,
    availability: "-2,5",
    balance: "143,27",
    id: "syn-late-september",
  }),
  row({
    at: "2026-09-20T13:45:12.000Z",
    name: "Caffè Sintetico",
    description: "Pranzo con buoni pasto",
    amount: "-20,23",
    type: STORE,
    availability: "-4,23",
    meal: "-16,00",
    balance: "145,77",
    id: "syn-purchase-cafe",
  }),
  row({
    at: "2026-09-15T09:00:00.000Z",
    name: "Banca Sintetica",
    description: "Ricarica precedente",
    amount: "+150,00",
    type: "🏦 Dalla Banca",
    availability: "+150,00",
    balance: "150,00",
    id: "syn-cutoff-topup",
  }),
];

function row(movement) {
  return {
    status: APPROVED,
    meal: null,
    flex: null,
    availability: null,
    ...movement,
  };
}

/** Excel 1900 date system. Serial 25569 is 1970-01-01T00:00:00.000Z. */
function excelSerial(isoUtc) {
  const ms = Date.parse(isoUtc);
  if (!Number.isFinite(ms)) throw new Error(`Invalid instant ${isoUtc}`);
  return ms / 86_400_000 + 25_569;
}

function excelNumber(value) {
  const text = String(value);
  return Number(text) === value ? text : value.toPrecision(17);
}

function xmlText(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function columnName(index) {
  let name = "";
  let n = index + 1;
  while (n > 0) {
    n -= 1;
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26);
  }
  return name;
}

function inlineString(ref, value) {
  return `<c r="${ref}" t="inlineStr"><is><t>${xmlText(value)}</t></is></c>`;
}

function sheetXml() {
  const header = HEADERS.map((name, index) => inlineString(`${columnName(index)}1`, name)).join("");
  const body = MOVEMENTS.map((movement, index) => {
    const excelRow = index + 2;
    const cells = [
      ["Data", `<c r="A${excelRow}" s="1"><v>${excelNumber(excelSerial(movement.at))}</v></c>`],
      ["Nome", movement.name],
      ["Descrizione", movement.description],
      ["Importo", movement.amount],
      ["Tipo", movement.type],
      ["Stato", movement.status],
      ["Disponibilità", movement.availability],
      ["Buoni Pasto", movement.meal],
      ["FlexBen", movement.flex],
      ["Disponibilità dopo la transazione", movement.balance],
      ["ID (Comunicalo all'Assistenza Clienti in caso di problemi)", movement.id],
    ];
    const xml = cells
      .filter(([, value]) => value !== null && value !== undefined && value !== "")
      .map(([name, value]) => {
        const ref = `${columnName(HEADERS.indexOf(name))}${excelRow}`;
        return name === "Data" ? value : inlineString(ref, value);
      })
      .join("");
    return `<row r="${excelRow}">${xml}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">${header}</row>${body}</sheetData></worksheet>`;
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy hh:mm:ss"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>`;

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Movimenti" sheetId="1" r:id="rId1"/></sheets></workbook>`;

const WORKBOOK_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

/** Deterministic ZIP (fixed DOS timestamp) so regeneration does not depend on the clock. */
function zip(files) {
  const time = 0;
  const date = 33; // 1980-01-01
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const data = Buffer.from(file.data);
    const name = Buffer.from(file.name);
    const compressed = deflateRawSync(data);
    const checksum = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const localRecord = Buffer.concat([local, name, compressed]);
    locals.push(localRecord);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    offset += localRecord.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDir, end]);
}

export function createRealisticWorkbook() {
  return zip([
    { name: "[Content_Types].xml", data: CONTENT_TYPES_XML },
    { name: "_rels/.rels", data: ROOT_RELS_XML },
    { name: "xl/workbook.xml", data: WORKBOOK_XML },
    { name: "xl/_rels/workbook.xml.rels", data: WORKBOOK_RELS_XML },
    { name: "xl/styles.xml", data: STYLES_XML },
    { name: "xl/worksheets/sheet1.xml", data: sheetXml() },
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = new URL("../tests/fixtures/satispay-realistic.xlsx", import.meta.url);
  writeFileSync(target, createRealisticWorkbook());
}
