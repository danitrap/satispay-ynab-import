import { Schema } from "effect";
import { calendarDate } from "./domain.ts";

export const CalendarDateSchema = Schema.String.check(
  Schema.makeFilter((value) => calendarDate(value) !== null),
).pipe(Schema.brand("CalendarDate"));
const Identifier = Schema.Trimmed.check(Schema.isMinLength(1));
export const YnabAccountIdSchema = Identifier.pipe(Schema.brand("YnabAccountId"));
export const YnabPlanIdSchema = Identifier.pipe(Schema.brand("YnabPlanId"));
