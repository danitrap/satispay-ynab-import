import { workbookReaderLayer } from "./workbook-reader.ts";
import { Context, Effect, Layer, Logger } from "effect";
import { appConfigLayer, type AppEnv } from "./config.ts";
import { FetchHttpClient } from "effect/http";
import type { ImportPlan } from "./import-plan.ts";
import type { YnabServiceApi } from "./ynab-contract.ts";
import { makeYnabClient } from "./ynab.ts";

export type { YnabServiceApi } from "./ynab-contract.ts";
export class YnabService extends Context.Service<YnabService, YnabServiceApi>()(
  "satispay/YnabService",
) {}

export const ynabHttpLayer = Layer.effect(YnabService, makeYnabClient);

/** Single request composition root. Never retain Cloudflare bindings in a global runtime. */
export const requestLiveLayer = (env: AppEnv, fetchFn: typeof fetch = fetch) => {
  const config = appConfigLayer(env);
  const transport = FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn)),
  );
  return Layer.mergeAll(
    ynabHttpLayer.pipe(Layer.provideMerge(config), Layer.provide(transport)),
    workbookReaderLayer,
    Logger.layer([Logger.withConsoleLog(Logger.formatStructured)]),
  );
};

export const ynabTestLayer = (service: YnabServiceApi) => Layer.succeed(YnabService, service);
export const findAccountsEffect = Effect.flatMap(YnabService, (service) => service.findAccounts);
export const importPlanEffect = (plan: ImportPlan) =>
  Effect.flatMap(YnabService, (service) => service.importPlan(plan));
