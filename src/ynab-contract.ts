import type { Effect } from "effect";
import type { YnabFailure } from "./errors.ts";
import type { ImportPlan } from "./import-plan.ts";

export type YnabAccount = {
  readonly id: string;
  readonly name: string;
  readonly on_budget: boolean;
  readonly closed: boolean;
  readonly deleted?: boolean;
};
export type YnabAccounts = {
  readonly matches: ReadonlyArray<{
    readonly planId: string;
    readonly planName: string;
    readonly accountId: string;
    readonly accountName: string;
    readonly onBudget: boolean;
  }>;
};
export type YnabImportResult = {
  readonly submitted: number;
  readonly processed: number;
  readonly duplicateImports: number;
  readonly ynabReportedTransactionIds: number;
};

/** Implementations close over their dependencies; callers only need this contract. */
export interface YnabServiceApi {
  readonly findAccounts: Effect.Effect<YnabAccounts, YnabFailure>;
  readonly validateAccount: Effect.Effect<YnabAccount, YnabFailure>;
  readonly importPlan: (plan: ImportPlan) => Effect.Effect<YnabImportResult, YnabFailure>;
}
