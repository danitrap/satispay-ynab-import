import { Context, Effect, Layer } from "effect";
import { AppConfig, appConfigLayer, type YnabEnv } from "./config.ts";
import { FetchHttpClient, HttpClient } from "effect/http";
import type { ImportPlan } from "./import-plan.ts";
import {
  findSatispayAccountsEffect,
  sendToYnabEffect,
  validateTargetAccountEffect,
} from "./ynab.ts";

type WithoutDependencies<T> =
  T extends Effect.Effect<infer A, infer E, any> ? Effect.Effect<A, E> : never;

export type YnabServiceApi = {
  readonly findAccounts: WithoutDependencies<ReturnType<typeof findSatispayAccountsEffect>>;
  readonly validateAccount: WithoutDependencies<ReturnType<typeof validateTargetAccountEffect>>;
  readonly importPlan: (
    plan: ImportPlan,
  ) => WithoutDependencies<ReturnType<typeof sendToYnabEffect>>;
};

export class YnabService extends Context.Service<YnabService, YnabServiceApi>()(
  "satispay/YnabService",
) {}

/** Request-scoped; Cloudflare bindings must never be captured in a global runtime. */
/** Build the application service from an injected Effect HttpClient.
 * No request starts until an Effect in the service is evaluated.
 */
export const ynabHttpLayer = Layer.effect(
  YnabService,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const config = yield* AppConfig;
    const provide = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient | AppConfig>) =>
      effect.pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provideService(AppConfig, config),
      );
    return {
      findAccounts: provide(findSatispayAccountsEffect()),
      validateAccount: provide(validateTargetAccountEffect()),
      importPlan: (plan: ImportPlan) => provide(sendToYnabEffect(plan)),
    };
  }),
);

/** Cloudflare fetch transport is created and disposed within each request. */
export const ynabLiveLayer = (env: YnabEnv, fetchFn: typeof fetch = fetch) =>
  ynabHttpLayer.pipe(
    Layer.provideMerge(appConfigLayer(env)),
    Layer.provide(
      FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn))),
    ),
  );

export const ynabTestLayer = (service: YnabServiceApi) => Layer.succeed(YnabService, service);

export const findAccountsEffect = Effect.flatMap(YnabService, (service) => service.findAccounts);
export const validateAccountEffect = Effect.flatMap(
  YnabService,
  (service) => service.validateAccount,
);
export const importPlanEffect = (plan: ImportPlan) =>
  Effect.flatMap(YnabService, (service) => service.importPlan(plan));
