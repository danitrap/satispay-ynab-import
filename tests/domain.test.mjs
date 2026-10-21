import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  calendarDate,
  parseCents,
  centsToMilliunits,
  makeCents,
  PlanInputError,
} from "../src/domain.ts";
import { buildImportPlan } from "../src/import-plan.ts";
import { analyzeLedger } from "../src/ledger.ts";
import { previewSatispay } from "../src/preview.ts";
import { Effect } from "effect";
import { importPlanEffect, ynabLiveLayer } from "../src/ynab-service.ts";

const headers = ["Data", "Nome", "Descrizione", "Importo", "Tipo", "Stato", "Disponibilità", "ID"];
const row = (id, amount) => ["2026-10-18", "Shop", "", amount, "Altro", "✅ Approvato", amount, id];

test("money constructors preserve exact cents and reject unsafe conversions", () => {
  assert.equal(parseCents(-12.34), -1234);
  assert.equal(centsToMilliunits(parseCents(-12.34)), -12340);
  assert.equal(parseCents(1.001), null);
  assert.equal(centsToMilliunits(makeCents(Number.MAX_SAFE_INTEGER)), null);
  assert.equal(calendarDate("2024-02-29"), "2024-02-29");
  assert.equal(calendarDate("2026-02-29"), null);
});

test("unsafe wallet amounts are rejected and accumulated totals cannot silently overflow", () => {
  const unsafe = buildImportPlan([headers, row("unsafe", 1e13)], "2026-10-01");
  assert.equal(unsafe.candidates.length, 0);
  assert.equal(unsafe.counts.rejected, 1);
  const preview = previewSatispay([headers, row("unsafe", 1e13)]);
  assert.equal(preview.eligible, 0);
  assert.equal(preview.requiresReview, 1);
  assert.throws(
    () => buildImportPlan([headers, row("a", 5e12), row("b", 5e12)], "2026-10-01"),
    (error) => error instanceof PlanInputError && error.reason === "AmountOverflow",
  );
});

test("balance audits report unavailable when milliunit deltas exceed the safe range", () => {
  const rows = [
    [...headers, "Disponibilità dopo la transazione"],
    [...row("a", 1), 5e12],
    [...row("b", 1), -5e12],
  ];
  assert.equal(analyzeLedger(rows).balanceCheck.reason, "unsafe_money_range");
});

test("account validation retains the specific rejection reason without leaking the account", async () => {
  const fetchFn = async () =>
    Response.json({
      data: { account: { id: "wallet", name: "Satispay", on_budget: true, closed: true } },
    });
  const error = await Effect.runPromise(
    importPlanEffect({ counts: { rejected: 0 }, candidates: [] }).pipe(
      Effect.provide(
        ynabLiveLayer(
          {
            YNAB_TOKEN: "fake",
            YNAB_PLAN_ID: "plan",
            YNAB_ACCOUNT_ID: "wallet",
            YNAB_WRITE_ENABLED: "true",
          },
          fetchFn,
        ),
      ),
      Effect.flip,
    ),
  );
  assert.equal(error._tag, "YnabAccountError");
  assert.equal(error.reason, "Closed");
  assert.equal(JSON.stringify(error).includes("wallet"), false);
});
