import { decodeCsv, parseCsv } from "./csv.ts";

type Env = { UPLOAD_TOKEN: string };
const MAX_FILE_BYTES = 1_000_000;
const MAX_REQUEST_BYTES = 1_200_000;

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
      return json({ ok: true, service: "satispay-ynab-import", mode: "inspect-only" });
    }
    if (request.method !== "POST" || url.pathname !== "/inspect") {
      return json({ ok: false, error: "Not found" }, 404);
    }
    if (!env.UPLOAD_TOKEN || request.headers.get("Authorization") !== "Bearer " + env.UPLOAD_TOKEN) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }
    const contentType = request.headers.get("Content-Type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
      return json({ ok: false, error: "Expected multipart/form-data with a file field" }, 415);
    }
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

    let file: File;
    try {
      const copied = new Request("https://local.invalid/inspect", {
        method: "POST",
        headers: { "Content-Type": contentType },
        body,
      });
      const form = await copied.formData();
      const part = form.get("file");
      if (!(part instanceof File)) return json({ ok: false, error: "Missing form field 'file'" }, 400);
      file = part;
    } catch {
      return json({ ok: false, error: "Invalid multipart/form-data" }, 400);
    }
    if (file.size > MAX_FILE_BYTES) return json({ ok: false, error: "CSV exceeds 1MB limit" }, 413);
    if (!file.name.toLowerCase().endsWith(".csv")) {
      return json({ ok: false, error: "Please choose CSV export (not Excel or PDF)" }, 415);
    }
    try {
      const parsed = parseCsv(decodeCsv(new Uint8Array(await file.arrayBuffer())));
      // No CSV contents are saved, logged, or transmitted to YNAB in this starter.
      return json({
        ok: true,
        mode: "inspect-only",
        fileName: file.name,
        delimiter: parsed.delimiter === "\t" ? "TAB" : parsed.delimiter,
        columns: parsed.headers,
        rowCount: parsed.rows.length,
        imported: 0,
        message: "CSV received and parsed. YNAB write is intentionally disabled until mapping is validated."
      });
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : "CSV parse error" }, 422);
    }
  },
};
