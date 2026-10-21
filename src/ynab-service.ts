import { Context, Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import type { ImportPlan } from "./import-plan.ts";
import {
  findSatispayAccountsEffect,
  sendToYnabEffect,
  validateTargetAccountEffect,
  type YnabEnv,
} from "./ynab.ts";

type WithoutHttp<T> = T extends Effect.Effect<infer A, infer E, any> ? Effect.Effect<A, E> : never;

export type YnabServiceApi = {
  readonly findAccounts: WithoutHttp<ReturnType<typeof findSatispayAccountsEffect>>;
  readonly validateAccount: WithoutHttp<ReturnType<typeof validateTargetAccountEffect>>;
  readonly importPlan: (plan: ImportPlan) => WithoutHttp<ReturnType<typeof sendToYnabEffect>>;
};

export class YnabService extends Context.Service<YnabService, YnabServiceApi>()(
  "satispay/YnabService",
) {}

/** Request-scoped; Cloudflare bindings must never be captured in a global runtime. */
/** Build the application service from an injected Effect HttpClient.
 * No request starts until an Effect in the service is evaluated.
 */
export const ynabHttpLayer = (env: YnabEnv) =>
  Layer.effect(
    YnabService,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      return {
        findAccounts: Effect.provideService(
          findSatispayAccountsEffect(env),
          HttpClient.HttpClient,
          http,
        ),
        validateAccount: Effect.provideService(
          validateTargetAccountEffect(env),
          HttpClient.HttpClient,
          http,
        ),
        importPlan: (plan: ImportPlan) =>
          Effect.provideService(sendToYnabEffect(plan, env), HttpClient.HttpClient, http),
      };
    }),
  );

/** Cloudflare fetch transport is created and disposed within each request. */
export const ynabLiveLayer = (env: YnabEnv, fetchFn: typeof fetch = fetch) =>
  ynabHttpLayer(env).pipe(
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
