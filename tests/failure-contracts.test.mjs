import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Cause, Effect } from "effect";
import { handleRequestEffect } from "../src/index.ts";
import { readSheetEffect, WorkbookError } from "../src/spreadsheet.ts";
import { WorkbookReader } from "../src/workbook-reader.ts";
import { importPlanEffect, requestLiveLayer } from "../src/ynab-service.ts";
import { ImportFailedError, YnabImportUncertainError } from "../src/errors.ts";

const headers = ["Data", "Nome", "Descrizione", "Importo", "Tipo", "Stato", "Disponibilità", "ID"];
const row = ["2026-10-18", "Shop", "", -5, "Altro", "✅ Approvato", -5, "id"];
const analyzeRows = (route, rows) =>
  handleRequestEffect(
    new Request(`https://local.invalid/${route}`, {
      method: "POST",
      headers: { Authorization: "Bearer upload" },
      body: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    }),
  ).pipe(
    Effect.provideService(WorkbookReader, { read: () => Effect.succeed(rows) }),
    Effect.provide(requestLiveLayer({ UPLOAD_TOKEN: "upload" })),
  );

test("expected inspection and preview input failures keep the HTTP 422 contract", async () => {
  for (const [route, rows] of [
    ["inspect", []],
    ["inspect", [["single column"]]],
    ["preview", []],
    ["preview", [["Data", "Nome"]]],
    ["preview", [headers.slice(0, -1), row.slice(0, -1)]],
    [
      "preview",
      [
        headers,
        [...row.slice(0, 3), 5e12, ...row.slice(4, 6), 5e12, "first"],
        [...row.slice(0, 3), 5e12, ...row.slice(4, 6), 5e12, "second"],
      ],
    ],
  ]) {
    const response = await Effect.runPromise(analyzeRows(route, rows));
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: "Cannot parse XLSX workbook. Check the exported Excel file.",
    });
  }
});

test("unexpected inspection and preview exceptions remain defects with their original identity", async () => {
  for (const route of ["inspect", "preview"]) {
    const defect = new TypeError("unexpected analysis bug");
    // The external decoder is the injected seam; no internal functions are mocked.
    const crashingCell = {
      [Symbol.toPrimitive]() {
        throw defect;
      },
    };
    const rows = [headers, [...row.slice(0, 4), crashingCell, ...row.slice(5)]];
    const exit = await Effect.runPromiseExit(analyzeRows(route, rows));
    assert.equal(exit._tag, "Failure");
    assert.equal(Cause.hasDies(exit.cause), true);
    const extracted = Cause.findDefect(exit.cause);
    assert.equal(extracted._tag, "Success");
    assert.equal(extracted.success, defect);
  }
});

test("uncertain HTTP failures always render their status and wrapper messages are derived", () => {
  const reason = new YnabImportUncertainError({ reason: { _tag: "Http", status: 503 } });
  assert.equal(reason.message, "YNAB API HTTP 503. Check import status before repeating.");
  const wrapped = new ImportFailedError({ reason, summary: {} });
  assert.equal(wrapped.message, reason.message);
  assert.equal(Object.hasOwn(wrapped, "message"), false);
});

test("an import posts only to the target snapshot that was validated", async () => {
  let targetReads = 0;
  const submitted = [];
  const env = {
    YNAB_TOKEN: "fake",
    YNAB_PLAN_ID: "plan",
    YNAB_WRITE_ENABLED: "true",
    get YNAB_ACCOUNT_ID() {
      return ++targetReads === 1 ? "wallet" : "unvalidated-wallet";
    },
  };
  const fetchFn = async (_url, init) => {
    if (init.method === "GET")
      return Response.json({
        data: { account: { id: "wallet", name: "Satispay", on_budget: true, closed: false } },
      });
    submitted.push(JSON.parse(init.body));
    return Response.json({ data: { transaction_ids: ["created"], duplicate_import_ids: [] } });
  };
  const plan = {
    counts: { rejected: 0 },
    candidates: [
      {
        satispayId: "id",
        date: "2026-10-18",
        amountMilliunits: -5000,
        payee: "Shop",
        memo: "",
        type: "Altro",
      },
    ],
  };
  const result = await Effect.runPromise(
    importPlanEffect(plan).pipe(Effect.provide(requestLiveLayer(env, fetchFn))),
  );
  assert.equal(result.processed, 1);
  assert.equal(targetReads, 1);
  assert.equal(submitted[0].transactions[0].account_id, "wallet");
});

test("workbook service preserves declared failures and unexpected defects", async () => {
  const error = new WorkbookError("Cannot parse XLSX workbook. Check the exported Excel file.");
  const failure = await Effect.runPromise(
    readSheetEffect(new ArrayBuffer(0)).pipe(
      Effect.provideService(WorkbookReader, { read: () => Effect.fail(error) }),
      Effect.flip,
    ),
  );
  assert.equal(failure, error);
  const defect = new TypeError("decoder implementation bug");
  const exit = await Effect.runPromiseExit(
    readSheetEffect(new ArrayBuffer(0)).pipe(
      Effect.provideService(WorkbookReader, { read: () => Effect.die(defect) }),
    ),
  );
  assert.equal(exit._tag, "Failure");
  assert.equal(Cause.findDefect(exit.cause).success, defect);
});
