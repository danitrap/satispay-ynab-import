import {
  centsToMilliunits,
  makeCents,
  makeMilliunits,
  type Cents,
  type Milliunits,
} from "../../src/domain.ts";
import { Schema } from "effect";
import { YnabAccountIdSchema, YnabPlanIdSchema } from "../../src/domain-schema.ts";
import { buildYnabTransactionsEffect } from "../../src/ynab.ts";

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
  buildYnabTransactionsEffect([], account);
  // @ts-expect-error A plan identifier cannot be used as a destination account.
  buildYnabTransactionsEffect([], plan);
}
