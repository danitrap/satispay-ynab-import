import type {
  ImportPlanError,
  YnabAccountError,
  YnabImportRejectedError,
  YnabImportUncertainError,
  YnabResponseError,
  YnabTransportError,
} from "./errors.ts";

/** One safe presentation policy; error values retain machine-readable reasons. */
export function failureMessage(
  error:
    | ImportPlanError
    | YnabAccountError
    | YnabImportRejectedError
    | YnabImportUncertainError
    | YnabResponseError
    | YnabTransportError,
): string {
  switch (error._tag) {
    case "ImportPlanError":
      return {
        InvalidCutoff: "Invalid YNAB_IMPORT_FROM: expected YYYY-MM-DD",
        EmptyWorkbook: "Empty Satispay spreadsheet",
        MissingColumns: "Missing Satispay export columns",
        MissingIdColumn: "Missing Satispay transaction ID column",
        AmountOverflow: "Wallet totals exceed the safe integer range",
      }[error.reason];
    case "YnabAccountError":
      return "Target must be an active on-budget account named Satispay";
    case "YnabImportRejectedError":
      return "Over 10,000 import candidates: use a shorter export";
    case "YnabTransportError":
      return error.reason === "Timeout" ? "YNAB request timed out." : "YNAB network error.";
    case "YnabResponseError":
      return {
        Json: "YNAB returned unexpected JSON.",
        Plans: "Cannot list YNAB plans",
        Accounts: "Cannot list YNAB accounts",
      }[error.reason];
    case "YnabImportUncertainError":
      if (error.reason._tag === "Http")
        return `YNAB API HTTP ${error.reason.status}. Check import status before repeating.`;
      return {
        Network: "YNAB network error. Check import status before repeating.",
        Timeout: "YNAB request timed out. Check import status before repeating.",
        Json: "YNAB returned unexpected JSON. Check import status before repeating.",
        Contract: "Unexpected YNAB response: verify results in YNAB before retrying",
        DuplicateCount:
          "Unexpected YNAB duplicate import count: verify results in YNAB before retrying",
      }[error.reason._tag];
  }
}
