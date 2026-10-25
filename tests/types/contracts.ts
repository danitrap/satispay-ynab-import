import { Effect } from "effect";
import { AppConfig } from "../../src/application/app-config.ts";
import {
  ImportBatchError,
  ImportWritesDisabledError,
} from "../../src/application/import-prepared.ts";
import type { ListYnabAccountsFailure } from "../../src/application/list-ynab-accounts.ts";
import type { YnabGatewayShape } from "../../src/application/ynab-gateway.ts";

type MustBeNever<T extends never> = T;
export type DiscoveryCannotFailAsWrite = MustBeNever<
  Extract<ListYnabAccountsFailure, ImportWritesDisabledError | ImportBatchError>
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

const outcome = {
  confirmed: 0,
  duplicate: 0,
  failed: 0,
  uncertain: 0,
  unattempted: 0,
  ynabReportedTransactionIds: 0,
} as const;

export function checkUncertainHttpReason() {
  new ImportBatchError({
    failure: { _tag: "Uncertain", reason: "Http", status: 503 },
    outcome,
  });
  new ImportBatchError({
    // @ts-expect-error An HTTP reason must carry its status.
    failure: { _tag: "Uncertain", reason: "Http" },
    outcome,
  });
  new ImportBatchError({
    // @ts-expect-error A non-HTTP reason cannot carry a status.
    failure: { _tag: "Uncertain", reason: "Network", status: 503 },
    outcome,
  });
}
