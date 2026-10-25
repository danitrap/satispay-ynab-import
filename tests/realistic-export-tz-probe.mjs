import { readFileSync } from "node:fs";
import { readSheet } from "read-excel-file/universal";
import { buildImportPlan } from "../src/import-plan.ts";

const file = readFileSync(new URL("./fixtures/satispay-realistic.xlsx", import.meta.url));
const bytes = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
const plan = buildImportPlan(await readSheet(bytes), "2026-10-01");
process.stdout.write(
  JSON.stringify({
    olderThanStart: plan.counts.olderThanStart,
    candidates: plan.candidates.map((candidate) => ({
      id: candidate.satispayId,
      date: candidate.date,
      amount: candidate.amountMilliunits,
    })),
  }),
);
