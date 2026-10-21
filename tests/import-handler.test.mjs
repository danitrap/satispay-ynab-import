import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { handleRequestEffect } from "../src/index.ts";
import { ynabLiveLayer } from "../src/ynab-service.ts";
import { processImportEffect } from "../src/import-handler.ts";

const workbook = readFileSync(new URL("./fixtures/satispay.xlsx", import.meta.url));
const runRequest = (
  mode,
  bindings = {},
  bytes = workbook,
  fetchFn = async () => {
    throw new Error("Unexpected network request");
  },
) => {
  const env = { UPLOAD_TOKEN: "upload-secret", YNAB_IMPORT_FROM: "2026-10-01", ...bindings };
  const request = new Request(`https://local.invalid/${mode}`, {
    method: "POST",
    headers: { Authorization: "Bearer upload-secret", "X-Confirm-Import": "yes" },
    body: bytes,
  });
  return Effect.runPromise(
    handleRequestEffect(request, env).pipe(Effect.provide(ynabLiveLayer(env, fetchFn))),
  );
};

test("prepare rejects impossible cutoff dates as configuration errors", async () => {
  const response = await runRequest("prepare", { YNAB_IMPORT_FROM: "2026-02-30" });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.imported, 0);
  assert.match(body.error, /YNAB_IMPORT_FROM/);
});

test("prepare builds a real workbook plan without YNAB credentials or a write switch", async () => {
  const response = await runRequest("prepare", { YNAB_WRITE_ENABLED: "invalid" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, "import-preview");
  assert.equal(body.eligible, 1);
  assert.equal(body.outflowMilliunits, 5000);
  assert.equal(body.imported, 0);
  assert.equal(JSON.stringify(body).includes("Synthetic Shop"), false);
  const outcome = await Effect.runPromise(
    processImportEffect("prepare", new Uint8Array(workbook).buffer).pipe(
      Effect.provide(ynabLiveLayer({ YNAB_IMPORT_FROM: "2026-10-01" })),
    ),
  );
  assert.equal(outcome._tag, "ImportPrepared");
  assert.equal(outcome.summary.eligible, 1);
});

test("imports default to disabled and preserve the plan summary in the refusal", async () => {
  const response = await runRequest("import");
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.mode, "import-failed");
  assert.equal(body.eligible, 1);
  assert.match(body.error, /disabled/);
});

test("an invalid write switch fails configuration without contacting YNAB", async () => {
  const response = await runRequest("import", { YNAB_WRITE_ENABLED: "yes" });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /YNAB_WRITE_ENABLED/);
});

test("duplicate movements block import and retain diagnostics without contacting YNAB", async () => {
  const duplicates = readFileSync(new URL("./fixtures/satispay-duplicates.xlsx", import.meta.url));
  const response = await runRequest("import", { YNAB_WRITE_ENABLED: "true" }, duplicates);
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.mode, "import-blocked");
  assert.equal(body.rejected, 2);
  assert.equal(body.imported, 0);
  assert.equal(body.issues.missing_nontext_or_duplicate_id, 2);
});

const targetBindings = {
  YNAB_TOKEN: "test",
  YNAB_PLAN_ID: "plan",
  YNAB_ACCOUNT_ID: "wallet",
  YNAB_WRITE_ENABLED: "true",
};
const validAccount = { id: "wallet", name: "Satispay", closed: false, on_budget: true };

test("an unsuitable destination is a validation error and performs no writes", async () => {
  let writes = 0;
  const response = await runRequest("import", targetBindings, workbook, async (_url, init) => {
    if (init.method === "POST") writes++;
    return Response.json({ data: { account: { ...validAccount, name: "Other account" } } });
  });
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.mode, "import-failed");
  assert.equal(body.eligible, 1);
  assert.match(body.error, /Satispay/);
  assert.equal(writes, 0);
});

test("completed imports preserve the HTTP contract and exact wallet amount", async () => {
  const submitted = [];
  const response = await runRequest("import", targetBindings, workbook, async (_url, init) => {
    if (init.method === "GET") return Response.json({ data: { account: validAccount } });
    submitted.push(JSON.parse(init.body));
    return Response.json({ data: { transaction_ids: ["tx-1"], duplicate_import_ids: [] } });
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, "import-completed");
  assert.equal(body.processed, 1);
  assert.equal(body.imported, 1);
  assert.equal(body.duplicateImports, 0);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].transactions[0].amount, -5000);
  assert.equal(submitted[0].transactions[0].account_id, "wallet");
});

test("an uncertain import preserves its summary and asks for verification without retrying", async () => {
  let writes = 0;
  const response = await runRequest("import", targetBindings, workbook, async (_url, init) => {
    if (init.method === "GET") return Response.json({ data: { account: validAccount } });
    writes++;
    throw new Error("private transport details");
  });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.mode, "import-failed");
  assert.equal(body.eligible, 1);
  assert.match(body.error, /Check import status/);
  assert.equal(JSON.stringify(body).includes("private transport details"), false);
  assert.equal(writes, 1);
});
