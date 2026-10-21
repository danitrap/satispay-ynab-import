import type { PlanInputReason } from "./domain.ts";
import { failureMessage } from "./failure-message.ts";
import { Data } from "effect";
import type { ConfigurationError } from "./config.ts";
import type { summarizeImportPlan } from "./import-plan.ts";

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
  readonly reason: "AmbiguousMovements" | "BatchTooLarge";
}> {
  override get message(): string {
    return failureMessage(this);
  }
}
export class YnabImportUncertainError extends Data.TaggedError("YnabImportUncertainError")<{
  readonly reason: "Network" | "Timeout" | "Http" | "Json" | "Contract" | "DuplicateCount";
  readonly status?: number;
}> {
  override get message(): string {
    return failureMessage(this);
  }
}

export type YnabFailure =
  | ConfigurationError
  | YnabError
  | YnabTransportError
  | YnabHttpError
  | YnabResponseError
  | YnabAccountError
  | YnabWriteDisabledError
  | YnabImportRejectedError
  | YnabImportUncertainError;

export class ImportPlanError extends Data.TaggedError("ImportPlanError")<{
  readonly reason: PlanInputReason;
}> {
  override get message(): string {
    return failureMessage(this);
  }
}
export class ImportBlockedError extends Data.TaggedError("ImportBlockedError")<{
  readonly summary: ImportSummary;
  readonly message: string;
}> {}
export class ImportFailedError extends Data.TaggedError("ImportFailedError")<{
  readonly summary: ImportSummary;
  readonly reason: YnabFailure;
  readonly message: string;
}> {}
