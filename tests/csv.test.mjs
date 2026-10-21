import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseCsv, decodeCsv } from "../src/csv.ts";
import worker from "../src/index.ts";

test("semicolon CSV, quoted semicolons, comma-decimal", () => {
  const csv = 'Data;Descrizione;Importo\r\n2026-10-16;"Bar; Milano";"-12,99"\r\n';
  const parsed = parseCsv(csv);
  assert.equal(parsed.delimiter, ";");
  assert.deepEqual(parsed.headers, ["Data", "Descrizione", "Importo"]);
  assert.deepEqual(parsed.rows, [["2026-10-16", "Bar; Milano", "-12,99"]]);
});
test("comma CSV, double-quote escaping and multiline", () => {
  const parsed = parseCsv('Date,Description,Amount\n2026-10-16,"Mr ""Coffee""\nMilano",-1.20\n');
  assert.equal(parsed.rows[0][1], 'Mr "Coffee"\nMilano');
});
test("UTF8 BOM", () => {
  const input = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("A;B\nx;y")]);
  assert.deepEqual(parseCsv(decodeCsv(input)).headers, ["A", "B"]);
});
test("worker returns header + count, never sends transactions", async () => {
  const fd = new FormData();
  fd.set(
    "file",
    new File(["Data;Descrizione;Importo\n2026-10-16;Coffee;-2,10"], "export.csv", {
      type: "text/csv",
    }),
  );
  const res = await worker.fetch(
    new Request("https://example.com/inspect", {
      method: "POST",
      headers: { Authorization: "Bearer TEST_SECRET" },
      body: fd,
    }),
    { UPLOAD_TOKEN: "TEST_SECRET" },
  );
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.rowCount, 1);
  assert.equal(body.imported, 0);
  assert.equal(JSON.stringify(body).includes("Coffee"), false);
});
test("worker rejects unauthenticated uploads", async () => {
  const res = await worker.fetch(new Request("https://example.com/inspect", { method: "POST" }), {
    UPLOAD_TOKEN: "SECRET",
  });
  assert.equal(res.status, 401);
});
