import type { ConfigurationError } from "./app-config.ts";
import type { CalendarDate, Milliunits, YnabAccountId, YnabPlanId } from "../domain.ts";
import { Context, Data, type Effect } from "effect";

/**
 * Thin YNAB port. Listing, reading and creating one import batch are the only
 * operations; write gating, batching and target-account rules stay in the import use case.
 */

export type YnabGatewayOperation = "listAccounts" | "readAccount" | "createImportBatch";

export type YnabGatewayFailureReason =
  | { readonly _tag: "Network" }
  | { readonly _tag: "Timeout" }
  | { readonly _tag: "Http"; readonly status: number }
  | { readonly _tag: "Response" }
  | { readonly _tag: "Contract" }
  | { readonly _tag: "Encode" };

/** Transport, HTTP and response-shape failures from one YNAB call. */
export class YnabGatewayError extends Data.TaggedError("YnabGatewayError")<{
  readonly operation: YnabGatewayOperation;
  readonly reason: YnabGatewayFailureReason;
}> {
  override get message(): string {
    switch (this.reason._tag) {
      case "Network":
        return "YNAB network error.";
      case "Timeout":
        return "YNAB request timed out.";
      case "Http":
        return "YNAB API HTTP " + this.reason.status + ". Check your plan, account and token.";
      case "Response":
        return "YNAB returned unexpected JSON.";
      case "Contract":
        return this.operation === "listAccounts"
          ? "Cannot list YNAB accounts"
          : "Unexpected YNAB response: verify results in YNAB before retrying";
      case "Encode":
        return "Cannot encode YNAB request";
    }
  }
}

export type YnabGatewayFailure = YnabGatewayError | ConfigurationError;

/** One account in a YNAB plan, already decoded from the YNAB response. */
export type YnabAccount = {
  readonly id: YnabAccountId;
  readonly name: string;
  readonly onBudget: boolean;
  readonly closed: boolean;
  readonly deleted: boolean;
};

/** One YNAB transaction ready to submit. Import identity is already assigned. */
export type YnabTransaction = {
  readonly accountId: YnabAccountId;
  readonly date: CalendarDate;
  readonly amountMilliunits: Milliunits;
  readonly payee: string;
  readonly memo?: string;
  readonly cleared: "cleared" | "uncleared";
  readonly approved: boolean;
  readonly flagColor?: "orange";
  readonly importId: string;
};

/** What YNAB reports after accepting one import batch. */
export type CreatedImportBatch = {
  readonly transactionIds: ReadonlyArray<string>;
  readonly duplicateImportIds: ReadonlyArray<string>;
};

export type YnabGatewayShape = {
  /** Accounts in one YNAB plan. The caller decides which names matter. */
  readonly listAccounts: (
    planId: YnabPlanId,
  ) => Effect.Effect<ReadonlyArray<YnabAccount>, YnabGatewayFailure>;
  /** One account, without applying wallet-account rules. */
  readonly readAccount: (
    planId: YnabPlanId,
    accountId: YnabAccountId,
  ) => Effect.Effect<YnabAccount, YnabGatewayFailure>;
  /**
   * Create one import batch. The live implementation attempts the POST once:
   * a timeout or a server error is not retried.
   */
  readonly createImportBatch: (input: {
    readonly planId: YnabPlanId;
    readonly transactions: ReadonlyArray<YnabTransaction>;
  }) => Effect.Effect<CreatedImportBatch, YnabGatewayFailure>;
};

export class YnabGateway extends Context.Service<YnabGateway, YnabGatewayShape>()(
  "satispay/YnabGateway",
) {}
