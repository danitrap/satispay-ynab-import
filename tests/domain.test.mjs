import { test } from "node:test";
import { strict as assert } from "node:assert";
import { calendarDate, parseCents, centsToMilliunits, makeCents } from "../src/domain.ts";
import { parseSatispayExport } from "../src/infrastructure/satispay-export-reader.ts";
import { buildPreparedImport, PreparedImportInputError } from "../src/prepared-import.ts";
import { previewSatispay } from "../src/preview.ts";
import { Effect } from "effect";
import { requestLiveLayer } from "../src/main.ts";
import { submitPreparedImportEffect } from "../src/ynab-service.ts";

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

test("Italian amount text is cent-exact and spreadsheet datetimes keep the UTC day", () => {
  assert.equal(parseCents("-12,50"), -1250);
  assert.equal(parseCents("-2,5"), -250);
  assert.equal(parseCents("+1.234,56"), 123456);
  assert.equal(parseCents("€ 9,90"), 990);
  assert.equal(parseCents("(12,50)"), -1250);
  assert.equal(parseCents("−3,39"), -339);
  assert.equal(parseCents("1.23"), 123);
  assert.equal(parseCents("not-a-number"), null);
  assert.equal(parseCents("1,001"), null);
  const calendarDay = (value) => {
    const parsed = parseSatispayExport([
      headers,
      [value, "Shop", "", -1, "Altro", "✅ Approvato", -1, "date-row"],
    ]);
    assert.equal(parsed._tag, "Export");
    const date = parsed.satispayExport.movements[0].date;
    assert.equal(date._tag, "Valid");
    return date.calendarDate;
  };
  assert.equal(calendarDay(new Date("2026-10-01T00:05:00.000Z")), "2026-10-01");
  assert.equal(calendarDay(new Date("2026-09-30T23:50:00.000Z")), "2026-09-30");
  assert.equal(calendarDay(new Date("2026-10-09T00:29:59.999Z")), "2026-10-09");
});

test("unsafe wallet amounts are rejected and accumulated totals cannot silently overflow", () => {
  const unsafe = buildPreparedImport([headers, row("unsafe", 1e13)], "2026-10-01");
  assert.equal(unsafe.candidates.length, 0);
  assert.equal(unsafe.counts.rejected, 1);
  const preview = previewSatispay([headers, row("unsafe", 1e13)]);
  assert.equal(preview.eligible, 0);
  assert.equal(preview.requiresReview, 1);
  assert.throws(
    () => buildPreparedImport([headers, row("a", 5e12), row("b", 5e12)], "2026-10-01"),
    (error) => error instanceof PreparedImportInputError && error.reason === "AmountOverflow",
  );
});

test("balance audits report unavailable when milliunit deltas exceed the safe range", () => {
  const rows = [
    [...headers, "Disponibilità dopo la transazione"],
    [...row("a", 1), 5e12],
    [...row("b", 1), -5e12],
  ];
  assert.equal(buildPreparedImport(rows, "2026-10-01").balanceCheck.reason, "unsafe_money_range");
});

test("account validation retains the specific rejection reason without leaking the account", async () => {
  const fetchFn = async () =>
    Response.json({
      data: { account: { id: "wallet", name: "Satispay", on_budget: true, closed: true } },
    });
  const error = await Effect.runPromise(
    submitPreparedImportEffect({ counts: { rejected: 0 }, candidates: [] }).pipe(
      Effect.provide(
        requestLiveLayer(
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
