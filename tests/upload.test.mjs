import { test } from "node:test";
import { strict as assert } from "node:assert";
import worker from "../src/main.ts";
import { summarizeSheet } from "../src/infrastructure/satispay-export-reader.ts";
const endpoint = "https://local.invalid/inspect";
const env = { UPLOAD_TOKEN: "test-secret" };
function raw(body, contentType = "application/octet-stream") {
  return worker.fetch(
    new Request(endpoint, {
      method: "POST",
      headers: { Authorization: "Bearer test-secret", "Content-Type": contentType },
      body,
    }),
    env,
  );
}
test("a CSV upload receives the unsupported-format response", async () => {
  const csv = "Data;Descrizione;Importo\n2026-10-18;Caffe;-3,50\n";
  const expected = { ok: false, error: "Preview/import supports XLSX only" };
  const routes = [
    ["/inspect", {}],
    ["/preview", {}],
    ["/prepare", {}],
    ["/import", { "X-Confirm-Import": "yes" }],
  ];
  for (const [path, extraHeaders] of routes) {
    const response = await worker.fetch(
      new Request(`https://local.invalid${path}`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-secret",
          "Content-Type": "text/csv",
          ...extraHeaders,
        },
        body: csv,
      }),
      env,
    );
    assert.equal(response.status, 415, path);
    assert.deepEqual(await response.json(), expected, path);
  }
  const form = new FormData();
  form.set("file", new File([csv], "export.csv", { type: "text/csv" }));
  const multipart = await worker.fetch(
    new Request(endpoint, {
      method: "POST",
      headers: { Authorization: "Bearer test-secret" },
      body: form,
    }),
    env,
  );
  assert.equal(multipart.status, 415);
  assert.deepEqual(await multipart.json(), expected);
});
test("gives actionable error for JSON uploads", async () => {
  const response = await raw("{}", "application/json");
  assert.equal(response.status, 415);
  assert.match((await response.json()).error, /Request Body/);
});
test("rejects old binary XLS", async () => {
  const response = await raw(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  assert.equal(response.status, 415);
});
test("validates XLSX ZIP header and reports invalid workbook", async () => {
  const response = await raw(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));
  assert.equal(response.status, 422);
});
test("summarizes Excel without exposing records", () => {
  const summary = summarizeSheet([
    ["Data", "Importo"],
    ["2026-10-18", -10],
    ["", null],
  ]);
  assert.deepEqual(summary.columns, ["Data", "Importo"]);
  assert.equal(summary.rowCount, 1);
});
test("health reports supported formats", async () => {
  const response = await worker.fetch(new Request("https://local.invalid/health"), env);
  const body = await response.json();
  assert.deepEqual(body.formats, ["xlsx"]);
});
