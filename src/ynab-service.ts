import { Context, Effect, Layer } from "effect";
import type { ImportPlan } from "./import-plan.ts";
import type { YnabServiceApi } from "./ynab-contract.ts";
import { makeYnabClient } from "./ynab.ts";

export type { YnabServiceApi } from "./ynab-contract.ts";
export class YnabService extends Context.Service<YnabService, YnabServiceApi>()(
  "satispay/YnabService",
) {}

export const ynabHttpLayer = Layer.effect(YnabService, makeYnabClient);

export const ynabTestLayer = (service: YnabServiceApi) => Layer.succeed(YnabService, service);
export const findAccountsEffect = Effect.flatMap(YnabService, (service) => service.findAccounts);
export const importPlanEffect = (plan: ImportPlan) =>
  Effect.flatMap(YnabService, (service) => service.importPlan(plan));
