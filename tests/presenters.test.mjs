import { test } from "node:test";
import { strict as assert } from "node:assert";
import { ConfigurationError } from "../src/application/app-config.ts";
import {
  ImportBatchError,
  ImportCandidateLimitError,
  ImportIdentityError,
  ImportTargetAccountError,
  ImportWritesDisabledError,
} from "../src/application/import-prepared.ts";
import { PreparedImportError } from "../src/application/prepare-import.ts";
import { YnabGatewayError } from "../src/application/ynab-gateway.ts";
import { WorkbookError } from "../src/errors.ts";
import { ImportFailedError } from "../src/import-handler.ts";
import {
  presentAccounts,
  presentAuthorization,
  presentConfirmRequired,
  presentHealth,
  presentImportCompleted,
  presentInspectXlsx,
  presentPreparedImport,
  presentPreview,
  presentRouteFailure,
} from "../src/http/presenters.ts";
import { uploadError } from "../src/http/upload.ts";

const summary = {
  exported: 2,
  olderThanStart: 0,
  withoutAvailability: 0,
  rejected: 0,
  provisional: 1,
  inScope: 2,
  issues: {},
  reviewIssues: { ambiguous_refund: 1 },
  requiresReview: 1,
  fromDate: "2026-10-01",
  inflowMilliunits: 0,
  outflowMilliunits: 5000,
  netMilliunits: -5000,
  refundsAdjusted: 0,
  refundsUnresolved: 1,
  balanceCheck: { status: "unavailable", reason: "insufficient_balance_snapshots" },
  eligible: 2,
};

const outcome = {
  confirmed: 2,
  duplicate: 1,
  failed: 0,
  uncertain: 0,
  unattempted: 0,
  ynabReportedTransactionIds: 1,
};

const failedImport = (reason) => new ImportFailedError({ summary, reason });

test("health presenter reports the ready mode and supported uploads", async () => {
  const response = presentHealth();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "satispay-ynab-import",
    mode: "ready",
    formats: ["xlsx"],
    upload: ["raw", "multipart"],
    routes: ["/inspect", "/preview", "/prepare", "/import", "/ynab/accounts"],
  });
  const missing = presentAuthorization({ _tag: "Unauthorized" });
  assert.equal(missing.status, 401);
  assert.deepEqual(await missing.json(), { ok: false, error: "Unauthorized" });
  const limited = presentAuthorization({ _tag: "RateLimited" });
  assert.equal(limited.status, 429);
});

test("accounts presenter returns the listing and maps discovery failures", async () => {
  const response = presentAccounts({
    matches: [
      {
        planId: "plan",
        planName: "Household",
        accountId: "wallet",
        accountName: "Satispay",
        onBudget: true,
      },
    ],
    truncated: false,
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.matches.length, 1);
  assert.equal(body.matches[0].accountName, "Satispay");
  assert.equal(body.truncated, false);
  assert.equal("mode" in body, false);

  const missing = presentRouteFailure(
    new ConfigurationError({ key: "YNAB_TOKEN", message: "Missing YNAB_TOKEN secret" }),
    "accounts",
  );
  assert.equal(missing.status, 409);
  assert.deepEqual(await missing.json(), { ok: false, error: "Missing YNAB_TOKEN secret" });

  const gateway = presentRouteFailure(
    new YnabGatewayError({ operation: "listPlans", reason: { _tag: "Network" } }),
    "accounts",
  );
  assert.equal(gateway.status, 502);
  assert.deepEqual(await gateway.json(), { ok: false, error: "YNAB network error." });
});

test("inspect presenter shapes workbook inspection and maps upload failures", async () => {
  const workbook = presentInspectXlsx(
    { columns: ["Data", "Importo"], rowCount: 1, sheet: 1, analysis: { types: null } },
    "export.xlsx",
  );
  assert.equal(workbook.status, 200);
  const workbookBody = await workbook.json();
  assert.equal(workbookBody.ok, true);
  assert.equal(workbookBody.format, "xlsx");
  assert.equal(workbookBody.fileName, "export.xlsx");
  assert.equal(workbookBody.rowCount, 1);
  assert.equal(workbookBody.imported, 0);
  assert.equal(workbookBody.message, "Excel received and parsed. Nothing sent to YNAB.");
  assert.equal("mode" in workbookBody, false);

  const unreadable = presentRouteFailure(
    new WorkbookError("Cannot parse XLSX workbook. Check the exported Excel file."),
    "inspect",
  );
  assert.equal(unreadable.status, 422);
  assert.deepEqual(await unreadable.json(), {
    ok: false,
    error: "Cannot parse XLSX workbook. Check the exported Excel file.",
  });

  const statuses = [
    ["MissingBody", 400],
    ["Unreadable", 400],
    ["MissingFileField", 400],
    ["InvalidMultipart", 400],
    ["EmptyFile", 400],
    ["TimedOut", 408],
    ["RequestTooLarge", 413],
    ["FileTooLarge", 413],
    ["JsonOrFormBody", 415],
    ["LegacyXls", 415],
    ["XlsxOnly", 415],
    ["InvalidXlsx", 422],
  ];
  for (const [reason, status] of statuses) {
    const response = presentRouteFailure(uploadError(reason), "inspect");
    assert.equal(response.status, status, reason);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(typeof body.error, "string");
    assert.equal("imported" in body, false);
  }
});

test("preview presenter names the dry run and keeps workbook failures free of import counts", async () => {
  const response = presentPreview(
    {
      rowCount: 4,
      eligible: 2,
      skipped: 2,
      message:
        "Dry run only. No transactions sent to YNAB. Transfers can be adjusted manually in YNAB.",
    },
    "export.xlsx",
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, "preview-only");
  assert.equal(body.ok, true);
  assert.equal(body.format, "xlsx");
  assert.equal(body.fileName, "export.xlsx");
  assert.equal(body.eligible, 2);
  assert.equal(body.imported, 0);
  assert.equal(body.message, "Dry run only: nothing sent to YNAB.");

  const failure = presentRouteFailure(
    new WorkbookError("Cannot parse XLSX workbook. Check the exported Excel file."),
    "preview",
  );
  assert.equal(failure.status, 422);
  assert.deepEqual(await failure.json(), {
    ok: false,
    error: "Cannot parse XLSX workbook. Check the exported Excel file.",
  });
});

test("prepare presenter names the prepared import and keeps configuration failures at 409", async () => {
  const response = presentPreparedImport(summary);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, "prepare-only");
  assert.equal(body.eligible, 2);
  assert.equal(body.fromDate, "2026-10-01");
  assert.equal(body.imported, 0);
  assert.equal(body.message, "No transactions have been sent to YNAB");

  const configuration = presentRouteFailure(
    new ConfigurationError({
      key: "YNAB_IMPORT_FROM",
      message: "Invalid YNAB_IMPORT_FROM: expected YYYY-MM-DD",
    }),
    "prepare",
  );
  assert.equal(configuration.status, 409);
  assert.deepEqual(await configuration.json(), {
    ok: false,
    error: "Invalid YNAB_IMPORT_FROM: expected YYYY-MM-DD",
    imported: 0,
  });

  const rejected = presentRouteFailure(
    new PreparedImportError({ reason: "EmptyWorkbook" }),
    "prepare",
  );
  assert.equal(rejected.status, 422);
  assert.equal((await rejected.json()).imported, 0);

  const workbook = presentRouteFailure(
    new WorkbookError("Cannot parse XLSX workbook. Check the exported Excel file."),
    "prepare",
  );
  assert.equal(workbook.status, 422);
  const workbookBody = await workbook.json();
  assert.equal(workbookBody.imported, 0);
  assert.equal("mode" in workbookBody, false);
});

test("import presenter reports completion and maps each import failure to its status", async () => {
  const completed = presentImportCompleted(summary, outcome);
  assert.equal(completed.status, 200);
  const completedBody = await completed.json();
  assert.equal(completedBody.mode, "import-completed");
  assert.equal(completedBody.eligible, 2);
  assert.equal(completedBody.submitted, 2);
  assert.equal(completedBody.processed, 1);
  assert.equal(completedBody.duplicateImports, 1);
  assert.equal(completedBody.imported, 1);
  assert.equal(completedBody.confirmed, 2);
  assert.equal(completedBody.notAttempted, 0);
  assert.match(completedBody.message, /Review and reconcile/);

  const refused = presentRouteFailure(failedImport(new ImportWritesDisabledError()), "import");
  assert.equal(refused.status, 403);
  const refusedBody = await refused.json();
  assert.equal(refusedBody.mode, "import-failed");
  assert.equal(refusedBody.eligible, 2);
  assert.equal(refusedBody.imported, 0);
  assert.match(refusedBody.error, /disabled/);
  assert.equal("submitted" in refusedBody, false);

  const stopped = {
    confirmed: 500,
    duplicate: 10,
    failed: 0,
    uncertain: 500,
    unattempted: 200,
    ynabReportedTransactionIds: 490,
  };
  const uncertain = presentRouteFailure(
    failedImport(
      new ImportBatchError({
        failure: { _tag: "Uncertain", reason: "Http", status: 503 },
        outcome: stopped,
      }),
    ),
    "import",
  );
  assert.equal(uncertain.status, 502);
  const uncertainBody = await uncertain.json();
  assert.equal(uncertainBody.mode, "import-failed");
  assert.equal(uncertainBody.processed, 490);
  assert.equal(uncertainBody.imported, 490);
  assert.equal(uncertainBody.uncertain, 500);
  assert.equal(uncertainBody.notAttempted, 200);
  assert.equal(uncertainBody.submitted, 1000);
  assert.match(uncertainBody.error, /503/);

  const identity = presentRouteFailure(
    failedImport(new ImportIdentityError({ outcome: stopped })),
    "import",
  );
  assert.equal(identity.status, 502);
  assert.equal((await identity.json()).imported, 490);

  const limit = presentRouteFailure(failedImport(new ImportCandidateLimitError()), "import");
  assert.equal(limit.status, 422);
  assert.equal((await limit.json()).imported, 0);

  const account = presentRouteFailure(
    failedImport(new ImportTargetAccountError({ reason: "WrongName" })),
    "import",
  );
  assert.equal(account.status, 422);
  assert.match((await account.json()).error, /Satispay/);

  const configuration = presentRouteFailure(
    failedImport(
      new ConfigurationError({ key: "YNAB_TOKEN", message: "Missing YNAB_TOKEN secret" }),
    ),
    "import",
  );
  assert.equal(configuration.status, 409);
  const configurationBody = await configuration.json();
  assert.equal(configurationBody.mode, "import-failed");
  assert.equal(configurationBody.imported, 0);

  const confirm = presentConfirmRequired();
  assert.equal(confirm.status, 403);
  assert.deepEqual(await confirm.json(), {
    ok: false,
    error: "Set X-Confirm-Import: yes to enable this request; no writes performed",
  });
});
