import type { YnabTransaction } from "./ynab-gateway.ts";
import type { CalendarDate, YnabAccountId } from "../domain/primitives.ts";
import type {
  AmbiguityReason,
  ImportCandidate,
  ProvisionalTransaction,
} from "../domain/movement-classification.ts";
import type { SatispayMovement } from "../domain/satispay-movement.ts";
import { Data, Effect } from "effect";

/**
 * Translation from a classified Satispay movement to one YNAB transaction.
 * Import identity is decided here. Changing the hash or its prefix creates duplicate
 * YNAB transactions on the next overlapping export.
 */

const IMPORT_IDENTITY_NAMESPACE = "satispay-transaction-id-v1:";

export class YnabImportIdentityError extends Data.TaggedError("YnabImportIdentityError")<{
  readonly message: string;
}> {
  constructor() {
    super({ message: "Could not create stable import ID." });
  }
}

/** `SPS:` plus the first 32 hex characters of SHA-256 over the movement identifier. */
export const importIdentity = (satispayMovementIdentifier: string) =>
  Effect.tryPromise({
    try: () =>
      crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(IMPORT_IDENTITY_NAMESPACE + satispayMovementIdentifier),
      ),
    catch: () => new YnabImportIdentityError(),
  }).pipe(
    Effect.map((hash) => {
      const hex = [...new Uint8Array(hash)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      return "SPS:" + hex.slice(0, 32);
    }),
  );

const clip = (value: string, fallback: string, maximum: number): string =>
  (value || fallback).slice(0, maximum);

/** ADR 0001 review memo. The wording stays stable so transaction review instructions do not drift. */
export function reviewMemo(reason: AmbiguityReason, description: string): string {
  const explanation = {
    ambiguous_refund_purchase: "Multiple original purchases match this refund.",
    refund_purchase_not_in_export: "The original purchase is absent from this export.",
    refund_purchase_funding_mismatch:
      "The original purchase has inconsistent wallet/benefit funding.",
    invalid_refund_details: "The refund details cannot be verified.",
    refund_exceeds_remaining_amount:
      "The refund exceeds the remaining wallet amount of the original purchase.",
    partial_refund_split_unknown:
      "The cash and benefit split of this partial refund cannot be determined.",
  }[reason];
  const instruction = `[Satispay review] ${explanation} Using reported Disponibilità as the provisional wallet amount. Verify the cash/benefit split, correct the amount, then clear, approve and remove the orange flag.`;
  return (instruction + (description ? "\n" + description : "")).slice(0, 500);
}

const payeeName = (movement: SatispayMovement, amountMilliunits: number): string => {
  if (amountMilliunits > 0 && movement.kind === "cashback") return "Satispay Cashback";
  const fallback = movement.typeLabel ? "Satispay — " + movement.typeLabel : "Satispay";
  return clip(movement.name || fallback, "Satispay", 80);
};

const selectedMovement = (
  movement: SatispayMovement,
): { readonly id: string; readonly date: CalendarDate } | undefined => {
  const identifier = movement.satispayMovementIdentifier;
  const date = movement.date;
  if (identifier._tag !== "Unique" || date._tag !== "Valid") return undefined;
  return { id: identifier.value, date: date.calendarDate };
};

/** ADR 0001: a provisional transaction is orange, explained, uncleared and not YNAB-approved. */
export const toYnabTransaction = Effect.fnUntraced(function* (
  candidate: ImportCandidate | ProvisionalTransaction,
  accountId: YnabAccountId,
) {
  const selected = selectedMovement(candidate.movement);
  if (!selected) return yield* Effect.die("A selected movement is missing its identifier or date");
  const importId = yield* importIdentity(selected.id);
  const provisional = candidate._tag === "ProvisionalTransaction";
  const memo = provisional
    ? reviewMemo(candidate.reason, candidate.movement.description)
    : clip(candidate.movement.description, "", 200);
  const transaction: YnabTransaction = {
    accountId,
    date: selected.date,
    amountMilliunits: candidate.amountMilliunits,
    payee: payeeName(candidate.movement, candidate.amountMilliunits),
    ...(memo ? { memo } : {}),
    cleared: provisional ? "uncleared" : "cleared",
    approved: false,
    ...(provisional ? { flagColor: "orange" as const } : {}),
    importId,
  };
  return transaction;
});
