import type { ConfigurationError } from "../application/app-config.ts";
import {
  reportedImportCounts,
  type ImportFailure,
  type ImportOutcome,
} from "../application/import-prepared.ts";
import type { YnabAccountListing } from "../application/list-ynab-accounts.ts";
import type { PreparedImportError, PreparedImportSummary } from "../application/prepare-import.ts";
import type { YnabGatewayError } from "../application/ynab-gateway.ts";
import type { AuthorizationDecision } from "./auth.ts";
import { type WorkbookError } from "../application/workbook-reader.ts";
import { type ImportFailedError } from "../application/process-import.ts";
import { UploadError, type UploadReason } from "./upload.ts";

/**
 * JSON responses for the Worker.
 * Preview, prepare and import modes name the operation:
 * `preview-only`, `prepare-only`, `import-completed`, `import-failed`.
 * This module chooses every response body, mode and status code.
 */

export type PresentedRoute = "accounts" | "inspect" | "preview" | "prepare" | "import";

export type PresentedFailure =
  | UploadError
  | ConfigurationError
  | WorkbookError
  | PreparedImportError
  | ImportFailedError
  | YnabGatewayError;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });

const uploadStatus = (reason: UploadReason): number => {
  switch (reason) {
    case "MissingBody":
    case "Unreadable":
    case "MissingFileField":
    case "InvalidMultipart":
    case "EmptyFile":
      return 400;
    case "TimedOut":
      return 408;
    case "RequestTooLarge":
    case "FileTooLarge":
      return 413;
    case "JsonOrFormBody":
    case "LegacyXls":
    case "XlsxOnly":
      return 415;
    case "InvalidXlsx":
      return 422;
  }
};

const importFailureStatus = (error: ImportFailure): number => {
  switch (error._tag) {
    case "ConfigurationError":
      return 409;
    case "ImportWritesDisabledError":
      return 403;
    case "ImportTargetAccountError":
    case "ImportCandidateLimitError":
      return 422;
    case "YnabGatewayError":
    case "ImportBatchError":
    case "ImportIdentityError":
      return 502;
  }
};

const importRoute = (route: PresentedRoute) => route === "prepare" || route === "import";

export const presentHealth = () =>
  json({
    ok: true,
    service: "satispay-ynab-import",
    mode: "ready",
    formats: ["xlsx"],
    upload: ["raw", "multipart"],
    routes: ["/inspect", "/preview", "/prepare", "/import", "/ynab/accounts"],
  });

export const presentNotFound = () => json({ ok: false, error: "Not found" }, 404);

export const presentAuthorization = (
  decision: Exclude<AuthorizationDecision, { readonly _tag: "Authorized" }>,
) =>
  decision._tag === "RateLimited"
    ? json({ ok: false, error: "Too many failed authentication attempts" }, 429)
    : json({ ok: false, error: "Unauthorized" }, 401);

export const presentConfirmRequired = () =>
  json(
    {
      ok: false,
      error: "Set X-Confirm-Import: yes to enable this request; no writes performed",
    },
    403,
  );

export const presentAccounts = (listing: YnabAccountListing) => json({ ok: true, ...listing });

export const presentInspectXlsx = <Summary extends object>(summary: Summary, fileName: string) =>
  json({
    ok: true,
    format: "xlsx",
    fileName,
    ...summary,
    imported: 0,
    message: "Excel received and parsed. Nothing sent to YNAB.",
  });

export const presentPreview = <Summary extends object>(summary: Summary, fileName: string) =>
  json({
    ok: true,
    format: "xlsx",
    fileName,
    ...summary,
    mode: "preview-only",
    imported: 0,
    message: "Dry run only: nothing sent to YNAB.",
  });

export const presentPreparedImport = (summary: PreparedImportSummary) =>
  json({
    ok: true,
    mode: "prepare-only",
    ...summary,
    imported: 0,
    message: "No transactions have been sent to YNAB",
  });

export const presentImportCompleted = (summary: PreparedImportSummary, outcome: ImportOutcome) => {
  const counts = reportedImportCounts(outcome);
  return json({
    ok: true,
    mode: "import-completed",
    ...summary,
    ...counts,
    imported: counts.processed,
    message:
      "YNAB processed the batch (new or matched transactions). Review and reconcile Satispay in YNAB.",
  });
};

export const presentImportFailed = (summary: PreparedImportSummary, reason: ImportFailure) => {
  const progress =
    reason._tag === "ImportBatchError" || reason._tag === "ImportIdentityError"
      ? reportedImportCounts(reason.outcome)
      : undefined;
  return json(
    {
      ok: false,
      mode: "import-failed",
      ...summary,
      ...(progress ? { ...progress, imported: progress.processed } : { imported: 0 }),
      error: reason.message,
    },
    importFailureStatus(reason),
  );
};

/** Map a tagged failure to the status its route already uses. */
export const presentRouteFailure = (error: PresentedFailure, route: PresentedRoute) => {
  switch (error._tag) {
    case "UploadError":
      return json({ ok: false, error: error.message }, uploadStatus(error.reason));
    case "ConfigurationError":
      return json(
        {
          ok: false,
          error: error.message,
          ...(importRoute(route) ? { imported: 0 } : {}),
        },
        409,
      );
    case "WorkbookError":
      return json(
        {
          ok: false,
          error: error.message,
          ...(importRoute(route) ? { imported: 0 } : {}),
        },
        422,
      );
    case "PreparedImportError":
      return json({ ok: false, error: error.message, imported: 0 }, 422);
    case "ImportFailedError":
      return presentImportFailed(error.summary, error.reason);
    case "YnabGatewayError":
      return json({ ok: false, error: error.message }, 502);
  }
};
