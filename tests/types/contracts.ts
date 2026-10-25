import { Effect } from "effect";
import { AppConfig } from "../../src/application/app-config.ts";
import { ImportWritesDisabledError } from "../../src/application/import-prepared.ts";
import type { YnabGatewayShape } from "../../src/application/ynab-gateway.ts";
import type { YnabServiceApi } from "../../src/ynab-contract.ts";
import { YnabImportUncertainError, YnabWriteDisabledError } from "../../src/errors.ts";

type MustBeNever<T extends never> = T;
export type DiscoveryCannotFailAsWrite = MustBeNever<
  Extract<
    Effect.Error<YnabServiceApi["findAccounts"]>,
    YnabWriteDisabledError | YnabImportUncertainError
  >
>;
export type ValidationCannotFailAsWrite = MustBeNever<
  Extract<
    Effect.Error<YnabServiceApi["validateAccount"]>,
    YnabWriteDisabledError | YnabImportUncertainError
  >
>;

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

export const gatewayHasThreeOperations: Exact<
  keyof YnabGatewayShape,
  "listAccounts" | "readAccount" | "createImportBatch"
> = true;

type GatewayCall = ReturnType<
  YnabGatewayShape["listAccounts" | "readAccount" | "createImportBatch"]
>;

export type GatewayLeavesConfigurationResolved = MustBeNever<
  Extract<Effect.Services<GatewayCall>, AppConfig>
>;

export type GatewayWriteIsNotTheWriteGate = MustBeNever<
  Extract<
    Effect.Error<ReturnType<YnabGatewayShape["createImportBatch"]>>,
    ImportWritesDisabledError
  >
>;

export function checkUncertainHttpReason() {
  new YnabImportUncertainError({ reason: { _tag: "Http", status: 503 } });
  // @ts-expect-error An HTTP reason must carry its status.
  new YnabImportUncertainError({ reason: { _tag: "Http" } });
  // @ts-expect-error A non-HTTP reason cannot carry a status.
  new YnabImportUncertainError({ reason: { _tag: "Network", status: 503 } });
}

// Public operations must be runnable without callers supplying infrastructure.
export function checkContract(client: YnabServiceApi) {
  Effect.runPromise(client.findAccounts);
  Effect.runPromise(client.validateAccount);
  const invalid: YnabServiceApi = {
    ...client,
    // @ts-expect-error A public implementation cannot leave configuration unresolved.
    findAccounts: Effect.flatMap(AppConfig, () => client.findAccounts),
  };
  return invalid;
}
