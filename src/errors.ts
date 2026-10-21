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
  readonly message: string;
}> {}
export class YnabHttpError extends Data.TaggedError("YnabHttpError")<{
  readonly status: number;
  readonly message: string;
}> {}
export class YnabResponseError extends Data.TaggedError("YnabResponseError")<{
  readonly message: string;
}> {}
export class YnabAccountError extends Data.TaggedError("YnabAccountError")<{
  readonly message: string;
}> {}
export class YnabWriteDisabledError extends Data.TaggedError("YnabWriteDisabledError")<{
  readonly message: string;
}> {}
export class YnabImportRejectedError extends Data.TaggedError("YnabImportRejectedError")<{
  readonly message: string;
}> {}
export class YnabImportUncertainError extends Data.TaggedError("YnabImportUncertainError")<{
  readonly message: string;
}> {}

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
  readonly message: string;
}> {}
export class ImportBlockedError extends Data.TaggedError("ImportBlockedError")<{
  readonly summary: ImportSummary;
  readonly message: string;
}> {}
export class ImportFailedError extends Data.TaggedError("ImportFailedError")<{
  readonly summary: ImportSummary;
  readonly reason: YnabFailure;
  readonly message: string;
}> {}
