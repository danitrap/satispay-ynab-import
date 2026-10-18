import { Context, Effect, Layer } from "effect";
import type { ImportPlan } from "./import-plan.ts";
import {
  findSatispayAccountsEffect,
  sendToYnabEffect,
  validateTargetAccountEffect,
  type YnabEnv
} from "./ynab.ts";

export type YnabServiceApi = {
  readonly findAccounts: ReturnType<typeof findSatispayAccountsEffect>;
  readonly validateAccount: ReturnType<typeof validateTargetAccountEffect>;
  readonly importPlan: (plan: ImportPlan) => ReturnType<typeof sendToYnabEffect>;
};

export class YnabService extends Context.Service<YnabService, YnabServiceApi>()("satispay/YnabService") {}

/** Request-scoped; Cloudflare bindings must never be captured in a global runtime. */
export const ynabLiveLayer = (env: YnabEnv, fetchFn: typeof fetch = fetch) =>
  Layer.succeed(YnabService, {
    findAccounts: findSatispayAccountsEffect(env, fetchFn),
    validateAccount: validateTargetAccountEffect(env, fetchFn),
    importPlan: (plan: ImportPlan) => sendToYnabEffect(plan, env, fetchFn)
  });

export const ynabTestLayer = (service: YnabServiceApi) =>
  Layer.succeed(YnabService, service);

export const findAccountsEffect = Effect.flatMap(YnabService, service => service.findAccounts);
export const validateAccountEffect = Effect.flatMap(YnabService, service => service.validateAccount);
export const importPlanEffect = (plan: ImportPlan) =>
  Effect.flatMap(YnabService, service => service.importPlan(plan));
