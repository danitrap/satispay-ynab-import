import { Effect, Schema } from "effect";
import type { ImportCandidate, ImportPlan } from "./import-plan.ts";

export type YnabEnv = {
  YNAB_TOKEN?: string;
  YNAB_PLAN_ID?: string;
  YNAB_ACCOUNT_ID?: string;
  YNAB_IMPORT_FROM?: string;
  YNAB_WRITE_ENABLED?: string;
};
type ApiFetch = typeof fetch;
// Every response from YNAB is untrusted: decode the minimal API contract.
const AccountSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  on_budget: Schema.Boolean,
  closed: Schema.Boolean,
  deleted: Schema.optionalKey(Schema.Boolean)
});
const PlansSchema = Schema.Struct({
  plans: Schema.Array(Schema.Struct({id: Schema.String, name: Schema.String}))
});
const AccountsSchema = Schema.Struct({accounts: Schema.Array(AccountSchema)});
const AccountResponseSchema = Schema.Struct({account: AccountSchema});
const ImportResultSchema = Schema.Struct({
  transaction_ids: Schema.Array(Schema.String),
  duplicate_import_ids: Schema.Array(Schema.String)
});

export class YnabError extends Error {
  readonly _tag = "YnabError";
  constructor(message: string) { super(message); this.name = "YnabError"; }
}

function requireToken(env: YnabEnv) {
  return env.YNAB_TOKEN
    ? Effect.succeed(env.YNAB_TOKEN)
    : Effect.fail(new YnabError("Missing YNAB_TOKEN secret"));
}

/** One Effect for transport, HTTP status and response decoding; errors are typed. */
function apiEffect(path:string, token:string, method="GET", body?:unknown, fetchFn:ApiFetch=fetch) {
  return Effect.gen(function* () {
    const res = yield* Effect.tryPromise({
      try: () => fetchFn("https://api.ynab.com/v1"+path, {
        method,
        headers: {
          Authorization: "Bearer " + token,
          Accept: "application/json",
          ...(body ? {"Content-Type":"application/json"} : {})
        },
        ...(body ? {body: JSON.stringify(body)} : {})
      }),
      catch: () => new YnabError("YNAB network error. Retrying with the same import IDs is safe.")
    });
    if (!res.ok) return yield* Effect.fail(new YnabError("YNAB API HTTP "+res.status+". Check your plan, account and token."));
    const parsed = yield* Effect.tryPromise({
      try: () => res.json() as Promise<{data?:unknown}>,
      catch: () => new YnabError("YNAB returned unexpected JSON. Check import status before repeating.")
    });
    if (!parsed || typeof parsed !== "object" || !("data" in parsed) || !parsed.data) {
      return yield* Effect.fail(new YnabError("YNAB returned unexpected JSON. Check import status before repeating."));
    }
    return parsed.data as unknown;
  });
}

export function findSatispayAccountsEffect(env:YnabEnv, fetchFn:ApiFetch=fetch) {
  return Effect.gen(function* () {
    const token=yield* requireToken(env);
    const rawPlans=yield* apiEffect("/plans",token,"GET",undefined,fetchFn);
    const {plans}=yield* Schema.decodeUnknownEffect(PlansSchema)(rawPlans).pipe(
      Effect.mapError(()=>new YnabError("Cannot list YNAB plans"))
    );
    const matches:{planId:string;planName:string;accountId:string;accountName:string;onBudget:boolean}[]=[];
    for(const plan of plans.slice(0,20)) {
      const rawAccounts=yield* apiEffect("/plans/"+encodeURIComponent(plan.id)+"/accounts",token,"GET",undefined,fetchFn);
      const {accounts}=yield* Schema.decodeUnknownEffect(AccountsSchema)(rawAccounts).pipe(
        Effect.mapError(()=>new YnabError("Cannot list YNAB accounts"))
      );
      for(const account of accounts) {
        if(account.name.toLowerCase().includes("satispay") && !account.closed && !account.deleted) {
          matches.push({planId:plan.id,planName:plan.name,accountId:account.id,accountName:account.name,onBudget:account.on_budget});
        }
      }
    }
    return {matches};
  });
}

export const findSatispayAccounts = (env:YnabEnv, fetchFn:ApiFetch=fetch) =>
  Effect.runPromise(findSatispayAccountsEffect(env,fetchFn));

export function validateTargetAccountEffect(env:YnabEnv, fetchFn:ApiFetch=fetch) {
  return Effect.gen(function* () {
    const token=yield* requireToken(env);
    if(!env.YNAB_PLAN_ID || !env.YNAB_ACCOUNT_ID) {
      return yield* Effect.fail(new YnabError("Set YNAB_PLAN_ID and YNAB_ACCOUNT_ID"));
    }
    const rawAccount=yield* apiEffect("/plans/"+encodeURIComponent(env.YNAB_PLAN_ID)+"/accounts/"+encodeURIComponent(env.YNAB_ACCOUNT_ID),token,"GET",undefined,fetchFn);
    const {account}=yield* Schema.decodeUnknownEffect(AccountResponseSchema)(rawAccount).pipe(
      Effect.mapError(()=>new YnabError("Target must be an active on-budget account named Satispay"))
    );
    if(!account || account.id!==env.YNAB_ACCOUNT_ID || !account.name.toLowerCase().includes("satispay") || !account.on_budget || account.closed || account.deleted) {
      return yield* Effect.fail(new YnabError("Target must be an active on-budget account named Satispay"));
    }
    return account;
  });
}
export const validateTargetAccount = (env:YnabEnv, fetchFn:ApiFetch=fetch) =>
  Effect.runPromise(validateTargetAccountEffect(env,fetchFn));

/** Preserve the original SHA-256 namespace and 36-character import IDs exactly. */
export function importIdEffect(satispayId:string) {
  return Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256",new TextEncoder().encode("satispay-transaction-id-v1:"+satispayId)),
    catch: () => new YnabError("Could not create stable import ID.")
  }).pipe(Effect.map(hash => "SPS:"+[...new Uint8Array(hash)].map(n=>n.toString(16).padStart(2,"0")).join("").slice(0,32)));
}
export const importId = (satispayId:string) => Effect.runPromise(importIdEffect(satispayId));

export function buildYnabTransactionsEffect(candidates:ImportCandidate[],accountId:string) {
  return Effect.forEach(candidates, row=>Effect.map(importIdEffect(row.satispayId),import_id=>({
    account_id:accountId,
    date:row.date,
    amount:row.amountMilliunits,
    payee_name:row.payee,
    memo:row.memo || undefined,
    cleared:"cleared" as const,
    approved:false,
    import_id
  })), {concurrency: 4});
}
export const buildYnabTransactions=(candidates:ImportCandidate[],accountId:string)=>
  Effect.runPromise(buildYnabTransactionsEffect(candidates,accountId));

export function sendToYnabEffect(plan:ImportPlan,env:YnabEnv,fetchFn:ApiFetch=fetch) {
  return Effect.gen(function* () {
    if(env.YNAB_WRITE_ENABLED!=="true") return yield* Effect.fail(new YnabError("YNAB write disabled: set YNAB_WRITE_ENABLED=true"));
    if(plan.counts.rejected>0) return yield* Effect.fail(new YnabError("Ambiguous transactions found: no YNAB writes performed"));
    if(plan.candidates.length>100) return yield* Effect.fail(new YnabError("Over 100 movements: use a shorter export"));
    yield* validateTargetAccountEffect(env,fetchFn);
    if(!plan.candidates.length) return {submitted:0,processed:0,duplicateImports:0,ynabReportedTransactionIds:0};
    const transactions=yield* buildYnabTransactionsEffect(plan.candidates,env.YNAB_ACCOUNT_ID!);
    const token=yield* requireToken(env);
    const rawResult=yield* apiEffect("/plans/"+encodeURIComponent(env.YNAB_PLAN_ID!)+"/transactions",token,"POST",{transactions},fetchFn);
    const data=yield* Schema.decodeUnknownEffect(ImportResultSchema)(rawResult).pipe(
      Effect.mapError(()=>new YnabError("Unexpected YNAB response: verify results in YNAB before retrying"))
    );
    const submitted=transactions.length;
    const duplicateImports=data.duplicate_import_ids.length;
    if(duplicateImports>submitted) return yield* Effect.fail(new YnabError("Unexpected YNAB duplicate import count"));
    return {submitted,processed:submitted-duplicateImports,duplicateImports,ynabReportedTransactionIds:data.transaction_ids.length};
  });
}
export const sendToYnab=(plan:ImportPlan,env:YnabEnv,fetchFn:ApiFetch=fetch)=>
  Effect.runPromise(sendToYnabEffect(plan,env,fetchFn));
