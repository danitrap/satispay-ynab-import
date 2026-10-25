import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Cause, Effect } from "effect";
import { SatispayExportReader } from "../src/application/satispay-export-reader.ts";
import { satispayExportReaderLayer } from "../src/infrastructure/satispay-export-reader.ts";
import { requestLiveLayer } from "../src/main.ts";
import { WorkbookError } from "../src/application/workbook-reader.ts";
import { WorkbookReader } from "../src/application/workbook-reader.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const headers = ["Data", "Nome", "Descrizione", "Importo", "Tipo", "Stato", "Disponibilità", "ID"];

function arrayBuffer(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function fixture(name) {
  return arrayBuffer(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
}

function row(values) {
  const cells = {
    Data: "2026-10-18",
    Nome: "Synthetic Shop",
    Descrizione: "Synthetic purchase",
    Importo: -5,
    Tipo: "Altro",
    Stato: "✅ Approvato",
    Disponibilità: -5,
    ID: "synthetic-1",
    ...values,
  };
  return headers.map((name) => cells[name]);
}

const readExport = (file) =>
  Effect.gen(function* () {
    const reader = yield* SatispayExportReader;
    return yield* reader.read(file);
  });

const readRows = (rows) =>
  readExport(new ArrayBuffer(0)).pipe(
    Effect.provide(satispayExportReaderLayer),
    Effect.provideService(WorkbookReader, { read: () => Effect.succeed(rows) }),
  );

const readFixture = (name) => readExport(fixture(name)).pipe(Effect.provide(requestLiveLayer({})));

const amount = (cents) => ({ _tag: "Amount", cents });
const absent = { _tag: "Absent" };
const on = (iso) => ({
  _tag: "Valid",
  calendarDate: iso.slice(0, 10),
  instantMs: Date.parse(iso),
});

function view(movement) {
  return {
    satispayMovementIdentifier: movement.satispayMovementIdentifier,
    date: movement.date,
    nominalAmount: movement.nominalAmount,
    reportedWalletAmount: movement.reportedWalletAmount,
    mealVoucherAmount: movement.mealVoucherAmount,
    flexBenefitAmount: movement.flexBenefitAmount,
    walletBalance: movement.walletBalance,
    satispayApproval: movement.satispayApproval,
    kind: movement.kind,
    typeLabel: movement.typeLabel,
    name: movement.name,
    description: movement.description,
  };
}

test("the minimal fixture is one approved wallet expense", async () => {
  const exported = await Effect.runPromise(readFixture("satispay.xlsx"));
  assert.equal(exported.includesWalletBalance, false);
  assert.deepEqual(exported.movements.map(view), [
    {
      satispayMovementIdentifier: { _tag: "Unique", value: "synthetic-1" },
      date: on("2026-10-18T00:00:00.000Z"),
      nominalAmount: amount(-500),
      reportedWalletAmount: amount(-500),
      mealVoucherAmount: absent,
      flexBenefitAmount: absent,
      walletBalance: absent,
      satispayApproval: "approved",
      kind: "other",
      typeLabel: "Altro",
      name: "Synthetic Shop",
      description: "Synthetic purchase",
    },
  ]);
});

test("the duplicate fixture carries both identifiers as duplicates", async () => {
  const exported = await Effect.runPromise(readFixture("satispay-duplicates.xlsx"));
  assert.equal(exported.movements.length, 2);
  assert.deepEqual(
    exported.movements.map((movement) => movement.satispayMovementIdentifier),
    [
      { _tag: "Duplicate", value: "synthetic-1" },
      { _tag: "Duplicate", value: "synthetic-1" },
    ],
  );
  assert.equal(exported.movements[0].nominalAmount.cents, -500);
  assert.equal(exported.movements[0].reportedWalletAmount.cents, -500);
});

test("the realistic fixture keeps nominal amounts, wallet amounts and calendar dates", async () => {
  const exported = await Effect.runPromise(readFixture("satispay-realistic.xlsx"));
  assert.equal(exported.includesWalletBalance, true);
  assert.equal(exported.movements.length, 14);
  const expectations = [
    [
      "syn-unknown",
      "2026-10-11T07:07:07.000Z",
      -300,
      -300,
      absent,
      absent,
      134456,
      "approved",
      "other",
      "Altro",
      "",
      "Movimento senza nome",
    ],
    [
      "syn-iban",
      "2026-10-10T15:00:00.000Z",
      123456,
      123456,
      absent,
      absent,
      134756,
      "approved",
      "other",
      "🏦 Bonifico Bancario in Entrata",
      "Banca Sintetica",
      "Bonifico in entrata",
    ],
    [
      "syn-morning-edge",
      "2026-10-09T00:29:59.999Z",
      -110,
      -110,
      absent,
      absent,
      11300,
      "approved",
      "merchantPurchase",
      "🏬 a un Negozio",
      "Chiosco Sintetico",
      "Giornale",
    ],
    [
      "syn-rejected",
      "2026-10-08T10:14:59.999Z",
      -999,
      -999,
      absent,
      absent,
      11410,
      "notApproved",
      "merchantPurchase",
      "🏬 a un Negozio",
      "Negozio Rifiutato",
      "Pagamento non riuscito",
    ],
    [
      "syn-refund-cafe",
      "2026-10-07T16:05:45.000Z",
      2023,
      2023,
      absent,
      absent,
      12409,
      "approved",
      "merchantRefund",
      "🔄 Rimborso",
      "Caffè Sintetico",
      "Rimborso pranzo",
    ],
    [
      "syn-p2p",
      "2026-10-06T19:40:00.000Z",
      -1500,
      -1500,
      absent,
      absent,
      11986,
      "approved",
      "other",
      "👤 a una Persona",
      "Persona Sintetica",
      "Compleanno",
    ],
    [
      "syn-cashback",
      "2026-10-05T08:00:01.000Z",
      339,
      339,
      absent,
      absent,
      13486,
      "approved",
      "cashback",
      "🎖️ Punti",
      "Satispay",
      "Accredito punti",
    ],
    [
      "syn-mixed",
      "2026-10-04T11:22:29.999Z",
      -3000,
      -1000,
      amount(-1200),
      amount(-800),
      13147,
      "approved",
      "merchantPurchase",
      "🏬 a un Negozio",
      "Market Misto",
      "Spesa mista",
    ],
    [
      "syn-flex-only",
      "2026-10-03T18:20:03.999Z",
      -2500,
      absent,
      absent,
      amount(-2500),
      14147,
      "approved",
      "merchantPurchase",
      "🏬 a un Negozio",
      "Palestra Sintetica",
      "Abbonamento FlexBen",
    ],
    [
      "syn-meal-only",
      "2026-10-02T12:10:00.000Z",
      -800,
      absent,
      amount(-800),
      absent,
      14147,
      "approved",
      "merchantPurchase",
      "🏬 a un Negozio",
      "Trattoria Sintetica",
      "Pasto solo buoni",
    ],
    [
      "syn-after-midnight",
      "2026-10-01T00:04:59.999Z",
      -180,
      -180,
      absent,
      absent,
      14147,
      "approved",
      "merchantPurchase",
      "🏬 a un Negozio",
      "Panificio Sintetico",
      "Cornetto",
    ],
    [
      "syn-late-september",
      "2026-09-30T23:50:00.000Z",
      -250,
      -250,
      absent,
      absent,
      14327,
      "approved",
      "merchantPurchase",
      "🏬 a un Negozio",
      "Edicola Sintetica",
      "Rivista",
    ],
    [
      "syn-purchase-cafe",
      "2026-09-20T13:45:12.000Z",
      -2023,
      -423,
      amount(-1600),
      absent,
      14577,
      "approved",
      "merchantPurchase",
      "🏬 a un Negozio",
      "Caffè Sintetico",
      "Pranzo con buoni pasto",
    ],
    [
      "syn-cutoff-topup",
      "2026-09-15T09:00:00.000Z",
      15000,
      15000,
      absent,
      absent,
      15000,
      "approved",
      "other",
      "🏦 Dalla Banca",
      "Banca Sintetica",
      "Ricarica precedente",
    ],
  ];
  assert.deepEqual(
    exported.movements.map(view),
    expectations.map(
      ([
        id,
        iso,
        nominal,
        wallet,
        meal,
        flex,
        balance,
        satispayApproval,
        kind,
        typeLabel,
        name,
        description,
      ]) => ({
        satispayMovementIdentifier: { _tag: "Unique", value: id },
        date: on(iso),
        nominalAmount: amount(nominal),
        reportedWalletAmount: typeof wallet === "number" ? amount(wallet) : wallet,
        mealVoucherAmount: meal,
        flexBenefitAmount: flex,
        walletBalance: amount(balance),
        satispayApproval,
        kind,
        typeLabel,
        name,
        description,
      }),
    ),
  );
  assert.equal(exported.movements[10].date.calendarDate, "2026-10-01");
  assert.equal(exported.movements[11].date.calendarDate, "2026-09-30");
});

test("missing identifiers, duplicate identifiers and bad dates stay on the movement", async () => {
  const exported = await Effect.runPromise(
    readRows([
      headers,
      [],
      row({ ID: "" }),
      row({ ID: "   ", Data: "yesterday" }),
      row({ ID: "same", Data: "2026-13-40" }),
      row({ ID: " same ", Data: new Date("not-a-date") }),
      row({ ID: "only-once", Data: 45123 }),
      row({ ID: 42, Nome: "  Kept Name  ", Descrizione: "  memo  " }),
      row({ ID: "zero", Disponibilità: 0, Importo: "nope" }),
    ]),
  );
  assert.deepEqual(
    exported.movements.map((movement) => movement.satispayMovementIdentifier),
    [
      { _tag: "Missing" },
      { _tag: "Missing" },
      { _tag: "Duplicate", value: "same" },
      { _tag: "Duplicate", value: "same" },
      { _tag: "Unique", value: "only-once" },
      { _tag: "NotText" },
      { _tag: "Unique", value: "zero" },
    ],
  );
  assert.deepEqual(
    exported.movements.map((movement) => movement.date._tag),
    ["Valid", "Invalid", "Invalid", "Invalid", "Invalid", "Valid", "Valid"],
  );
  assert.equal(exported.movements[5].name, "Kept Name");
  assert.equal(exported.movements[5].description, "memo");
  assert.deepEqual(exported.movements[6].nominalAmount, { _tag: "Unreadable" });
  assert.deepEqual(exported.movements[6].reportedWalletAmount, amount(0));
  assert.equal(exported.movements[4].satispayApproval, "approved");
});

test("a rejected status label is not Satispay approval", async () => {
  const exported = await Effect.runPromise(
    readRows([headers, row({ ID: "rejected", Stato: "❌ Rifiutato" })]),
  );
  assert.equal(exported.movements[0].satispayApproval, "notApproved");
  assert.equal(exported.movements[0].kind, "other");
});

test("known movement labels map without keeping the decision in the domain", async () => {
  const exported = await Effect.runPromise(
    readRows([
      headers,
      row({ ID: "store", Tipo: "🏬 a un Negozio" }),
      row({ ID: "refund", Tipo: "🔄 Rimborso" }),
      row({ ID: "points", Tipo: "🎖️ Punti" }),
    ]),
  );
  assert.deepEqual(
    exported.movements.map((movement) => movement.kind),
    ["merchantPurchase", "merchantRefund", "cashback"],
  );
});

test("benefit and wallet-balance columns are optional and empty cells are absent", async () => {
  const withBalances = [...headers, "Buoni Pasto", "FlexBen", "Disponibilità dopo la transazione"];
  const exported = await Effect.runPromise(
    readRows([
      withBalances,
      [...row({ ID: "split" }), "-1,50", "", "10,00"],
      [...row({ ID: "empty-balance", Disponibilità: "" }), "", "", ""],
    ]),
  );
  assert.equal(exported.includesWalletBalance, true);
  assert.deepEqual(exported.movements[0].mealVoucherAmount, amount(-150));
  assert.deepEqual(exported.movements[0].flexBenefitAmount, absent);
  assert.deepEqual(exported.movements[0].walletBalance, amount(1000));
  assert.deepEqual(exported.movements[1].reportedWalletAmount, absent);
  assert.deepEqual(exported.movements[1].walletBalance, absent);
});

test("headers are matched by name, including a padded identifier column", async () => {
  const named = [
    " ID (Comunicalo all'Assistenza Clienti in caso di problemi) ",
    " Stato ",
    " Disponibilità ",
    " Tipo ",
    " Descrizione ",
    " Nome ",
    " Importo ",
    " Data ",
  ];
  const exported = await Effect.runPromise(
    readRows([
      named,
      ["moved", "✅ Approvato", "-2,5", "Altro", "note", "-", "-2,5", "2026-10-18"],
    ]),
  );
  assert.deepEqual(view(exported.movements[0]), {
    satispayMovementIdentifier: { _tag: "Unique", value: "moved" },
    date: on("2026-10-18T00:00:00.000Z"),
    nominalAmount: amount(-250),
    reportedWalletAmount: amount(-250),
    mealVoucherAmount: absent,
    flexBenefitAmount: absent,
    walletBalance: absent,
    satispayApproval: "approved",
    kind: "other",
    typeLabel: "Altro",
    name: "",
    description: "note",
  });
});

test("header problems are a typed error and a header alone is an empty export", async () => {
  const reasons = [
    [[], "EmptyExport"],
    [[["only"]], "MissingColumns"],
    [[headers.slice(0, -1), row().slice(0, -1)], "MissingMovementIdentifier"],
    [
      [
        ["Data", "Nome", "Descrizione", "Tipo", "Stato", "Disponibilità", "ID"],
        ["2026-10-18", "Shop", "", "Altro", "✅ Approvato", -5, "id"],
      ],
      "MissingColumns",
    ],
  ];
  for (const [rows, reason] of reasons) {
    const exit = await Effect.runPromiseExit(readRows(rows));
    assert.equal(exit._tag, "Failure");
    assert.equal(Cause.hasDies(exit.cause), false);
    const failure = await Effect.runPromise(readRows(rows).pipe(Effect.flip));
    assert.equal(failure._tag, "SatispayExportHeaderError");
    assert.equal(failure.reason, reason);
  }
  const empty = await Effect.runPromise(readRows([headers, [], []]));
  assert.deepEqual(empty.movements, []);
  assert.equal(empty.includesWalletBalance, false);
});

test("an unreadable workbook stays a workbook error", async () => {
  const error = new WorkbookError("Cannot parse XLSX workbook. Check the exported Excel file.");
  const failure = await Effect.runPromise(
    readExport(new ArrayBuffer(0)).pipe(
      Effect.provide(satispayExportReaderLayer),
      Effect.provideService(WorkbookReader, { read: () => Effect.fail(error) }),
      Effect.flip,
    ),
  );
  assert.equal(failure, error);
});

test("column names and status labels stay in the export reader", () => {
  const ownedByTheReader = [
    "Importo",
    "Disponibilità",
    "Buoni Pasto",
    "FlexBen",
    "Approvato",
    "Negozio",
    "Rimborso",
    "Punti",
  ];
  const readerPath = join(repoRoot, "src/infrastructure/satispay-export-reader.ts");
  const reader = readFileSync(readerPath, "utf8");
  for (const label of ownedByTheReader) assert.equal(reader.includes(label), true, label);

  const files = typescriptFiles(join(repoRoot, "src")).filter((path) => path !== readerPath);
  for (const path of files) {
    const source = readFileSync(path, "utf8");
    for (const label of [...ownedByTheReader, "Rifiutato", "Comunicalo"]) {
      // ADR 0001 quotes Disponibilità in the provisional review memo. That sentence is not export parsing.
      if (label === "Disponibilità" && path.endsWith("/application/ynab-transaction.ts")) continue;
      assert.equal(source.includes(label), false, `${path} contains ${label}`);
    }
  }
});

function typescriptFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return typescriptFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}
