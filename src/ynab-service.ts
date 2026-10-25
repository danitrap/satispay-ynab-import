import { Context, Effect, Layer } from "effect";
import type { YnabImportCandidate } from "./prepared-import.ts";
import type { YnabServiceApi } from "./ynab-contract.ts";
import { makeYnabClient } from "./ynab.ts";

export type { YnabServiceApi } from "./ynab-contract.ts";
export class YnabService extends Context.Service<YnabService, YnabServiceApi>()(
  "satispay/YnabService",
) {}

export const ynabHttpLayer = Layer.effect(YnabService, makeYnabClient);

export const ynabTestLayer = (service: YnabServiceApi) => Layer.succeed(YnabService, service);
export const findAccountsEffect = Effect.flatMap(YnabService, (service) => service.findAccounts);
export const submitPreparedImportEffect = (prepared: {
  readonly candidates: readonly YnabImportCandidate[];
}) => Effect.flatMap(YnabService, (service) => service.submitPreparedImport(prepared));
