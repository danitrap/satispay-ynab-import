import { YnabGateway, type YnabGatewayFailure } from "./ynab-gateway.ts";
import type { YnabAccountId, YnabPlanId } from "../domain.ts";
import { Context, Effect } from "effect";

/**
 * Lists accessible YNAB accounts whose name contains Satispay.
 * The gateway lists every account in one plan; this use case chooses which plans to inspect
 * and which accounts are worth showing.
 */

const MAX_DISCOVERED_PLANS = 20;

export type YnabPlan = {
  readonly id: YnabPlanId;
  readonly name: string;
};

/** Plans the token can see. Account rules stay in the listing use case. */
export class YnabPlanCatalog extends Context.Service<
  YnabPlanCatalog,
  {
    readonly listPlans: () => Effect.Effect<ReadonlyArray<YnabPlan>, YnabGatewayFailure>;
  }
>()("satispay/YnabPlanCatalog") {}

export type YnabAccountMatch = {
  readonly planId: YnabPlanId;
  readonly planName: string;
  readonly accountId: YnabAccountId;
  readonly accountName: string;
  readonly onBudget: boolean;
};

export type YnabAccountListing = {
  readonly matches: ReadonlyArray<YnabAccountMatch>;
  /** True when YNAB returned more plans than this discovery pass inspects. */
  readonly truncated: boolean;
};

export type ListYnabAccountsFailure = YnabGatewayFailure;

const isDiscoverable = (name: string, closed: boolean, deleted: boolean) =>
  name.toLowerCase().includes("satispay") && !closed && !deleted;

/**
 * Discover Satispay-named accounts. Inspects at most 20 plans and stops if a YNAB read fails.
 * `Effect.fn` returns a function; calling it yields the effect callers run.
 */
export const listYnabAccounts = Effect.fn("satispay.ynab.findAccounts")(function* () {
  const catalog = yield* YnabPlanCatalog;
  const gateway = yield* YnabGateway;
  const plans = yield* catalog.listPlans();
  const discovered = plans.slice(0, MAX_DISCOVERED_PLANS);
  const matches: YnabAccountMatch[] = [];
  for (const plan of discovered) {
    const accounts = yield* gateway.listAccounts(plan.id);
    for (const account of accounts) {
      if (!isDiscoverable(account.name, account.closed, account.deleted)) continue;
      matches.push({
        planId: plan.id,
        planName: plan.name,
        accountId: account.id,
        accountName: account.name,
        onBudget: account.onBudget,
      });
    }
  }
  return { matches, truncated: plans.length > discovered.length } satisfies YnabAccountListing;
})();
