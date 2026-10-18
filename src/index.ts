import { decodeCsv, parseCsv } from "./csv.ts";
import { inspectXlsx } from "./spreadsheet.ts";

type Env = { UPLOAD_TOKEN: string };
const MAX_FILE_BYTES = 4_000_000;
const MAX_REQUEST_BYTES = 4_500_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "satispay-ynab-import", mode: "inspect-only", formats: ["xlsx","csv"], upload: ["raw","multipart"] });
    }
    if (request.method !== "POST" || url.pathname !== "/inspect") {
      return json({ ok: false, error: "Not found" }, 404);
    }
    if (!env.UPLOAD_TOKEN || request.headers.get("Authorization") !== "Bearer " + env.UPLOAD_TOKEN) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }
    const contentType = request.headers.get("Content-Type") ?? "application/octet-stream";
    const contentLength = Number(request.headers.get("Content-Length") ?? "0");
    if (contentLength > MAX_REQUEST_BYTES) return json({ ok: false, error: "Upload too large" }, 413);
    // Bound memory use even when the caller sends no Content-Length.
    let body: Uint8Array;
    try {
      const reader = request.body?.getReader();
      if (!reader) return json({ ok: false, error: "Missing request body" }, 400);
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > MAX_REQUEST_BYTES) {
          await reader.cancel();
          return json({ ok: false, error: "Upload too large" }, 413);
        }
        chunks.push(next.value);
      }
      body = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    } catch {
      return json({ ok: false, error: "Cannot read request" }, 400);
    }

    let fileName = "shared-file";
    let bytes = body;
    if (contentType.toLowerCase().startsWith("multipart/form-data")) {
      try {
        const copied = new Request("https://local.invalid/inspect", {
          method: "POST", headers: { "Content-Type": contentType }, body
        });
        const form = await copied.formData();
        const part = form.get("file");
        if (!(part instanceof Blob)) {
          return json({ ok: false, error: "Missing form field 'file'. Use Request Body → File → Shortcut Input instead." }, 400);
        }
        bytes = new Uint8Array(await part.arrayBuffer());
        if (part instanceof File) fileName = part.name;
      } catch {
        return json({ ok: false, error: "Invalid multipart form. Use Request Body → File in Shortcuts." }, 400);
      }
    } else if (/application\/(json|x-www-form-urlencoded)/i.test(contentType)) {
      return json({ ok: false, error: "Set Shortcuts Request Body → File → Shortcut Input, not JSON or Form." }, 415);
    }
    if (bytes.length > MAX_FILE_BYTES) return json({ ok: false, error: "File exceeds 4 MB" }, 413);
    if (bytes.length === 0) return json({ ok: false, error: "Empty file" }, 400);
    const xlsMagic = [0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1];
    if (fileName.toLowerCase().endsWith(".xls") || xlsMagic.every((v,i) => bytes[i] === v)) {
      return json({ ok: false, error: "Legacy .xls not supported: export .xlsx" }, 415);
    }
    const xlsx = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
    if (xlsx) {
      try {
        const inspection = await inspectXlsx(bytes.buffer as ArrayBuffer);
        return json({ ok: true, mode: "inspect-only", format: "xlsx", fileName, ...inspection,
          imported: 0, message: "Excel received and parsed. Nothing sent to YNAB." });
      } catch {
        return json({ ok: false, error: "Cannot parse XLSX workbook. Check the exported Excel file." }, 422);
      }
    }
    if (fileName.toLowerCase().endsWith(".xlsx") || contentType.toLowerCase().includes("spreadsheetml")) {
      return json({ ok: false, error: "Not a valid XLSX (ZIP signature missing)" }, 422);
    }
    try {
      const parsed = parseCsv(decodeCsv(bytes));
      // No CSV contents are saved, logged, or transmitted to YNAB in this starter.
      return json({
        ok: true,
        mode: "inspect-only",
        fileName,
        delimiter: parsed.delimiter === "\t" ? "TAB" : parsed.delimiter,
        columns: parsed.headers,
        format: "csv",
        rowCount: parsed.rows.length,
        imported: 0,
        message: "CSV received and parsed. YNAB write is intentionally disabled until mapping is validated."
      });
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : "CSV parse error" }, 422);
    }
  },
};
