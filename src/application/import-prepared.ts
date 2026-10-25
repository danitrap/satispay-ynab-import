import { AppConfig, type ConfigurationError } from "./app-config.ts";
import {
  YnabGateway,
  YnabGatewayError,
  type YnabAccount,
  type YnabGatewayFailureReason,
} from "./ynab-gateway.ts";
import { toYnabTransaction } from "./ynab-transaction.ts";
import type { YnabAccountId } from "../domain.ts";
import type { PreparedImport } from "../domain/prepared-import.ts";
import type { ImportCandidate, ProvisionalTransaction } from "../domain/movement-classification.ts";
import type { SatispayMovement } from "../domain/satispay-movement.ts";
import { Data, Effect } from "effect";

/**
 * Imports one prepared import into the YNAB wallet account.
 * Owns the write gate, the candidate limit, sequential batches, target-account rules,
 * and import outcome counting. The gateway only performs the YNAB calls.
 */

const IMPORT_CANDIDATE_LIMIT = 10_000;
const IMPORT_BATCH_SIZE = 500;

/** Confirmed, duplicate, failed, uncertain and unattempted candidates from one import. */
export type ImportOutcome = {
  readonly confirmed: number;
  readonly duplicate: number;
  readonly failed: number;
  readonly uncertain: number;
  readonly unattempted: number;
  /** YNAB transaction ids in confirmed batches. Matching can make this larger than `confirmed`. */
  readonly ynabReportedTransactionIds: number;
};

export type TargetAccountReason =
  "Malformed" | "WrongId" | "WrongName" | "OffBudget" | "Closed" | "Deleted";

export class ImportWritesDisabledError extends Data.TaggedError("ImportWritesDisabledError")<{
  readonly message: string;
}> {
  constructor() {
    super({ message: "YNAB write disabled: set YNAB_WRITE_ENABLED=true" });
  }
}

export class ImportCandidateLimitError extends Data.TaggedError("ImportCandidateLimitError")<{
  readonly message: string;
}> {
  constructor() {
    super({ message: "Over 10,000 import candidates: use a shorter export" });
  }
}

export class ImportTargetAccountError extends Data.TaggedError("ImportTargetAccountError")<{
  readonly reason: TargetAccountReason;
}> {
  override get message(): string {
    return "Target must be an active on-budget account named Satispay";
  }
}

export type ImportWriteFailure =
  | {
      readonly _tag: "Uncertain";
      readonly reason: "Network" | "Timeout" | "Response" | "Contract" | "DuplicateCount";
    }
  | { readonly _tag: "Uncertain"; readonly reason: "Http"; readonly status: number }
  | { readonly _tag: "Rejected"; readonly reason: "Http"; readonly status: number }
  | { readonly _tag: "Rejected"; readonly reason: "Encode" };

/** The import stopped on the first failed batch. Earlier batches stay in `outcome`. */
export class ImportBatchError extends Data.TaggedError("ImportBatchError")<{
  readonly failure: ImportWriteFailure;
  readonly outcome: ImportOutcome;
}> {
  override get message(): string {
    const failure = this.failure;
    if (failure._tag === "Rejected") {
      return failure.reason === "Encode"
        ? "Cannot encode YNAB request"
        : "YNAB API HTTP " + failure.status + ". Check your plan, account and token.";
    }
    if (failure.reason === "Http")
      return `YNAB API HTTP ${failure.status}. Check import status before repeating.`;
    return {
      Network: "YNAB network error. Check import status before repeating.",
      Timeout: "YNAB request timed out. Check import status before repeating.",
      Response: "YNAB returned unexpected JSON. Check import status before repeating.",
      Contract: "Unexpected YNAB response: verify results in YNAB before retrying",
      DuplicateCount:
        "Unexpected YNAB duplicate import count: verify results in YNAB before retrying",
    }[failure.reason];
  }
}

/** Identity could not be computed. The current batch was not submitted. */
export class ImportIdentityError extends Data.TaggedError("ImportIdentityError")<{
  readonly outcome: ImportOutcome;
}> {
  override get message(): string {
    return "Could not create stable import ID.";
  }
}

export type ImportFailure =
  | ConfigurationError
  | ImportWritesDisabledError
  | ImportCandidateLimitError
  | ImportTargetAccountError
  | YnabGatewayError
  | ImportBatchError
  | ImportIdentityError;

/** Counts the current import response still reports from one import outcome. */
export const reportedImportCounts = (outcome: ImportOutcome) => {
  const processed = outcome.confirmed - outcome.duplicate;
  return {
    submitted: outcome.confirmed + outcome.uncertain + outcome.failed,
    processed,
    duplicateImports: outcome.duplicate,
    ynabReportedTransactionIds: outcome.ynabReportedTransactionIds,
    confirmed: outcome.confirmed,
    uncertain: outcome.uncertain,
    failed: outcome.failed,
    notAttempted: outcome.unattempted,
  };
};

const emptyOutcome = (unattempted: number): ImportOutcome => ({
  confirmed: 0,
  duplicate: 0,
  failed: 0,
  uncertain: 0,
  unattempted,
  ynabReportedTransactionIds: 0,
});

const isImportCandidate = (
  classified: PreparedImport["movements"][number],
): classified is ImportCandidate | ProvisionalTransaction =>
  classified._tag === "ImportCandidate" || classified._tag === "ProvisionalTransaction";

const sortKey = (movement: SatispayMovement): readonly [string, string] => {
  const date = movement.date._tag === "Valid" ? movement.date.calendarDate : "";
  const identifier = movement.satispayMovementIdentifier;
  const id =
    identifier._tag === "Unique" || identifier._tag === "Duplicate" ? identifier.value : "";
  return [date, id];
};

const targetAccountReason = (
  account: YnabAccount,
  accountId: YnabAccountId,
): TargetAccountReason | undefined => {
  if (account.id !== accountId) return "WrongId";
  if (!account.name.toLowerCase().includes("satispay")) return "WrongName";
  if (!account.onBudget) return "OffBudget";
  if (account.closed) return "Closed";
  if (account.deleted) return "Deleted";
  return undefined;
};

const classifyWrite = (reason: YnabGatewayFailureReason): ImportWriteFailure => {
  switch (reason._tag) {
    case "Network":
    case "Timeout":
    case "Response":
    case "Contract":
      return { _tag: "Uncertain", reason: reason._tag };
    case "Encode":
      return { _tag: "Rejected", reason: "Encode" };
    case "Http":
      return reason.status >= 500
        ? { _tag: "Uncertain", reason: "Http", status: reason.status }
        : { _tag: "Rejected", reason: "Http", status: reason.status };
  }
};

const selectCandidates = (prepared: PreparedImport) =>
  prepared.movements.filter(isImportCandidate).sort((left, right) => {
    const [leftDate, leftId] = sortKey(left.movement);
    const [rightDate, rightId] = sortKey(right.movement);
    return leftDate.localeCompare(rightDate) || leftId.localeCompare(rightId);
  });

/** Submit a prepared import. Stops at the first failed batch and reports the outcome so far. */
export const importPrepared = Effect.fn("satispay.importPrepared")(function* (
  prepared: PreparedImport,
) {
  const config = yield* AppConfig;
  const gateway = yield* YnabGateway;
  if (!(yield* config.writesEnabled)) return yield* new ImportWritesDisabledError();
  const candidates = selectCandidates(prepared);
  if (candidates.length > IMPORT_CANDIDATE_LIMIT) return yield* new ImportCandidateLimitError();
  const target = yield* config.target;
  const account = yield* gateway
    .readAccount(target.planId, target.accountId)
    .pipe(
      Effect.mapError((error) =>
        error._tag === "YnabGatewayError" && error.reason._tag === "Contract"
          ? new ImportTargetAccountError({ reason: "Malformed" })
          : error,
      ),
    );
  const reason = targetAccountReason(account, target.accountId);
  if (reason) return yield* new ImportTargetAccountError({ reason });

  let outcome = emptyOutcome(candidates.length);
  // Sequential batches. The gateway attempts each POST once; the next batch waits for this one.
  for (let offset = 0; offset < candidates.length; offset += IMPORT_BATCH_SIZE) {
    const slice = candidates.slice(offset, offset + IMPORT_BATCH_SIZE);
    const transactions = yield* Effect.forEach(
      slice,
      (candidate) => toYnabTransaction(candidate, target.accountId),
      { concurrency: 4 },
    ).pipe(Effect.mapError(() => new ImportIdentityError({ outcome })));
    const size = transactions.length;
    const attempted: ImportOutcome = { ...outcome, unattempted: outcome.unattempted - size };
    const created = yield* gateway.createImportBatch({ planId: target.planId, transactions }).pipe(
      Effect.mapError((error) => {
        if (error._tag === "ConfigurationError") return error;
        const failure = classifyWrite(error.reason);
        const uncertain = failure._tag === "Uncertain";
        return new ImportBatchError({
          failure,
          outcome: {
            ...attempted,
            uncertain: uncertain ? size : 0,
            failed: uncertain ? 0 : size,
          },
        });
      }),
    );
    if (created.duplicateImportIds.length > size) {
      return yield* new ImportBatchError({
        failure: { _tag: "Uncertain", reason: "DuplicateCount" },
        outcome: { ...attempted, uncertain: size, failed: 0 },
      });
    }
    const duplicates = created.duplicateImportIds.length;
    outcome = {
      ...attempted,
      confirmed: attempted.confirmed + size,
      duplicate: attempted.duplicate + duplicates,
      ynabReportedTransactionIds:
        attempted.ynabReportedTransactionIds + created.transactionIds.length,
    };
  }
  return outcome;
});
