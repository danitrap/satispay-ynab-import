import {
  centsToMilliunits,
  makeCents,
  makeMilliunits,
  type Cents,
  type Milliunits,
} from "../../src/domain.ts";
import { Schema } from "effect";
import { YnabAccountIdSchema, YnabPlanIdSchema } from "../../src/domain-schema.ts";
import { toYnabTransaction } from "../../src/application/ynab-transaction.ts";
import type { ImportCandidate } from "../../src/domain/movement-classification.ts";

const candidate = {
  _tag: "ImportCandidate",
  amountMilliunits: -1000,
  walletAmount: -100,
  movement: {
    satispayMovementIdentifier: { _tag: "Unique", value: "synthetic" },
    date: { _tag: "Valid", calendarDate: "2026-10-18", instantMs: 0 },
    nominalAmount: { _tag: "Absent" },
    reportedWalletAmount: { _tag: "Amount", cents: -100 },
    mealVoucherAmount: { _tag: "Absent" },
    flexBenefitAmount: { _tag: "Absent" },
    walletBalance: { _tag: "Absent" },
    satispayApproval: "approved",
    kind: "other",
    typeLabel: "Altro",
    name: "Shop",
    description: "",
  },
} as ImportCandidate;

export function checkMoneyTypes(cents: Cents, milliunits: Milliunits) {
  centsToMilliunits(cents);
  // @ts-expect-error Milliunits cannot be converted as if they were cents.
  centsToMilliunits(milliunits);
  // @ts-expect-error Plain numbers must pass through a validating constructor.
  const invalid: Cents = 100;
  return { invalid, cents: makeCents(100), milliunits: makeMilliunits(1000) };
}
export function checkIdentifiers() {
  const account = Schema.decodeUnknownSync(YnabAccountIdSchema)("wallet");
  const plan = Schema.decodeUnknownSync(YnabPlanIdSchema)("plan");
  toYnabTransaction(candidate, account);
  // @ts-expect-error A plan identifier cannot be used as a destination account.
  toYnabTransaction(candidate, plan);
}
