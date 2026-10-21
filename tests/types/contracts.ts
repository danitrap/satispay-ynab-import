import { Effect } from "effect";
import { AppConfig } from "../../src/config.ts";
import type { YnabServiceApi } from "../../src/ynab-contract.ts";

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
