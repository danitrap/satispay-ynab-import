import type { PlanInputReason } from "./domain.ts";
import { failureMessage } from "./failure-message.ts";
import { Data } from "effect";
import type { ConfigurationError } from "./config.ts";
import type { summarizeImportPlan } from "./import-plan.ts";
import type { YnabImportResult } from "./ynab-contract.ts";

export type ImportSummary = ReturnType<typeof summarizeImportPlan>;

export class YnabError extends Data.TaggedError("YnabError")<{ readonly message: string }> {
  constructor(message: string) {
    super({ message });
  }
}

export class YnabTransportError extends Data.TaggedError("YnabTransportError")<{
  readonly reason: "Network" | "Timeout";
}> {
  override get message(): string {
    return failureMessage(this);
  }
}
export class YnabHttpError extends Data.TaggedError("YnabHttpError")<{
  readonly status: number;
  readonly message: string;
}> {}
export class YnabResponseError extends Data.TaggedError("YnabResponseError")<{
  readonly reason: "Json" | "Plans" | "Accounts";
}> {
  override get message(): string {
    return failureMessage(this);
  }
}
export class YnabAccountError extends Data.TaggedError("YnabAccountError")<{
  readonly reason: "Malformed" | "WrongId" | "WrongName" | "OffBudget" | "Closed" | "Deleted";
}> {
  override get message(): string {
    return failureMessage(this);
  }
}
export class YnabWriteDisabledError extends Data.TaggedError("YnabWriteDisabledError")<{
  readonly message: string;
}> {}
export class YnabImportRejectedError extends Data.TaggedError("YnabImportRejectedError")<{
  readonly reason: "BatchTooLarge";
}> {
  override get message(): string {
    return failureMessage(this);
  }
}
export class YnabImportUncertainError extends Data.TaggedError("YnabImportUncertainError")<{
  readonly reason:
    | { readonly _tag: "Http"; readonly status: number }
    | { readonly _tag: "Network" | "Timeout" | "Json" | "Contract" | "DuplicateCount" };
}> {
  override get message(): string {
    return failureMessage(this);
  }
}

export class YnabImportBatchError extends Data.TaggedError("YnabImportBatchError")<{
  readonly reason: YnabError | YnabHttpError | YnabImportUncertainError;
  readonly progress: YnabImportResult;
}> {
  override get message(): string {
    return this.reason.message;
  }
}

export type YnabReadFailure =
  ConfigurationError | YnabTransportError | YnabHttpError | YnabResponseError;
export type YnabAccountFailure = YnabReadFailure | YnabAccountError;
export type YnabImportFailure =
  | YnabAccountFailure
  | YnabError
  | YnabWriteDisabledError
  | YnabImportRejectedError
  | YnabImportUncertainError
  | YnabImportBatchError;
export type YnabFailure = YnabImportFailure;

export class ImportPlanError extends Data.TaggedError("ImportPlanError")<{
  readonly reason: PlanInputReason;
}> {
  override get message(): string {
    return failureMessage(this);
  }
}
export class ImportFailedError extends Data.TaggedError("ImportFailedError")<{
  readonly summary: ImportSummary;
  readonly reason: YnabImportFailure;
}> {
  override get message(): string {
    return this.reason.message;
  }
}

export class WorkbookError extends Data.TaggedError("WorkbookError")<{ readonly message: string }> {
  constructor(message: string) {
    super({ message });
  }
}
