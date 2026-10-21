import type { YnabAccountId, YnabPlanId } from "./domain.ts";
import type { Effect } from "effect";
import type { YnabReadFailure, YnabAccountFailure, YnabImportFailure } from "./errors.ts";
import type { ImportPlan } from "./import-plan.ts";

export type YnabAccount = {
  readonly id: YnabAccountId;
  readonly name: string;
  readonly on_budget: boolean;
  readonly closed: boolean;
  readonly deleted?: boolean;
};
export type YnabAccounts = {
  readonly matches: ReadonlyArray<{
    readonly planId: YnabPlanId;
    readonly planName: string;
    readonly accountId: YnabAccountId;
    readonly accountName: string;
    readonly onBudget: boolean;
  }>;
};
export type YnabImportResult = {
  readonly submitted: number;
  readonly processed: number;
  readonly duplicateImports: number;
  readonly ynabReportedTransactionIds: number;
  readonly confirmed: number;
  readonly uncertain: number;
  readonly failed: number;
  readonly notAttempted: number;
};

/** Implementations close over their dependencies; callers only need this contract. */
export interface YnabServiceApi {
  readonly findAccounts: Effect.Effect<YnabAccounts, YnabReadFailure>;
  readonly validateAccount: Effect.Effect<YnabAccount, YnabAccountFailure>;
  readonly importPlan: (plan: ImportPlan) => Effect.Effect<YnabImportResult, YnabImportFailure>;
}
