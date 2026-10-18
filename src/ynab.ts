import type { ImportCandidate, ImportPlan } from "./import-plan.ts";

export type YnabEnv = {
  YNAB_TOKEN?: string;
  YNAB_PLAN_ID?: string;
  YNAB_ACCOUNT_ID?: string;
  YNAB_IMPORT_FROM?: string;
  YNAB_WRITE_ENABLED?: string;
};
type ApiFetch = typeof fetch;
type Account = { id: string; name: string; on_budget: boolean; closed: boolean; deleted?: boolean };

async function api(path:string,token:string,method="GET",body?:unknown,fetchFn:ApiFetch=fetch):Promise<any> {
  let res:Response;
  try {
    res=await fetchFn("https://api.ynab.com/v1"+path,{
      method,
      headers:{"Authorization":"Bearer "+token,"Accept":"application/json",...(body?{"Content-Type":"application/json"}:{})},
      ...(body?{body:JSON.stringify(body)}:{})
    });
  } catch {
    throw new Error("YNAB network error. Retrying with the same import IDs is safe.");
  }
  if (!res.ok) throw new Error("YNAB API HTTP "+res.status+". Check your plan, account and token.");
  try {
    const parsed=await res.json() as any;
    if (!parsed || !parsed.data) throw new Error("missing data");
    return parsed.data;
  } catch {
    throw new Error("YNAB returned unexpected JSON. Check import status before repeating.");
  }
}
function requireToken(env:YnabEnv):string{
  if(!env.YNAB_TOKEN)throw new Error("Missing YNAB_TOKEN secret");
  return env.YNAB_TOKEN;
}
export async function findSatispayAccounts(env:YnabEnv,fetchFn:ApiFetch=fetch) {
  const token=requireToken(env);
  const plans=(await api("/plans",token,"GET",undefined,fetchFn)).plans as {id:string;name:string}[];
  if (!Array.isArray(plans)) throw new Error("Cannot list YNAB plans");
  const matches:{planId:string;planName:string;accountId:string;accountName:string;onBudget:boolean}[]=[];
  for(const plan of plans.slice(0,20)) {
    const accounts=(await api("/plans/"+encodeURIComponent(plan.id)+"/accounts",token,"GET",undefined,fetchFn)).accounts as Account[];
    for(const account of accounts??[]) {
      if (account.name.toLowerCase().includes("satispay") && !account.closed && !account.deleted) {
        matches.push({planId:plan.id,planName:plan.name,accountId:account.id,accountName:account.name,onBudget:account.on_budget});
      }
    }
  }
  return {matches};
}
export async function validateTargetAccount(env:YnabEnv,fetchFn:ApiFetch=fetch) {
  const token=requireToken(env);
  if (!env.YNAB_PLAN_ID || !env.YNAB_ACCOUNT_ID) throw new Error("Set YNAB_PLAN_ID and YNAB_ACCOUNT_ID");
  const data=await api("/plans/"+encodeURIComponent(env.YNAB_PLAN_ID)+"/accounts/"+encodeURIComponent(env.YNAB_ACCOUNT_ID),token,"GET",undefined,fetchFn);
  const account=data.account as Account|undefined;
  if(!account || account.id!==env.YNAB_ACCOUNT_ID || !account.name.toLowerCase().includes("satispay") || !account.on_budget || account.closed || account.deleted)
    throw new Error("Target must be an active on-budget account named Satispay");
  return account;
}
export async function importId(satispayId:string):Promise<string> {
  const input=new TextEncoder().encode("satispay-transaction-id-v1:"+satispayId);
  const hash=await crypto.subtle.digest("SHA-256",input);
  const hex=[...new Uint8Array(hash)].map(n=>n.toString(16).padStart(2,"0")).join("");
  return "SPS:"+hex.slice(0,32); // stable, 36 chars, nonreversible
}
export async function buildYnabTransactions(candidates:ImportCandidate[],accountId:string) {
  return Promise.all(candidates.map(async row=>({
    account_id:accountId,
    date:row.date,
    amount:row.amountMilliunits,
    payee_name:row.payee,
    memo:row.memo || undefined,
    cleared:"cleared",
    approved:false,
    import_id:await importId(row.satispayId)
  })));
}
export async function sendToYnab(plan:ImportPlan,env:YnabEnv,fetchFn:ApiFetch=fetch) {
  if(env.YNAB_WRITE_ENABLED!=="true")throw new Error("YNAB write disabled: set YNAB_WRITE_ENABLED=true");
  if(plan.counts.rejected>0)throw new Error("Ambiguous transactions found: no YNAB writes performed");
  if(plan.candidates.length>100)throw new Error("Over 100 movements: use a shorter export");
  await validateTargetAccount(env,fetchFn);
  if(!plan.candidates.length)return {submitted:0,processed:0,duplicateImports:0,ynabReportedTransactionIds:0};
  const transactions=await buildYnabTransactions(plan.candidates,env.YNAB_ACCOUNT_ID!);
  const data=await api("/plans/"+encodeURIComponent(env.YNAB_PLAN_ID!)+"/transactions",requireToken(env),"POST",{transactions},fetchFn);
  if(!Array.isArray(data.transaction_ids) || !Array.isArray(data.duplicate_import_ids))
    throw new Error("Unexpected YNAB response: verify results in YNAB before retrying");
  // The API may return multiple transaction IDs for a single submitted movement
  // (e.g. matching an existing manually-entered transaction). Do not use that
  // array length as the number of Satispay movements processed.
  const submitted=transactions.length;
  const duplicateImports=data.duplicate_import_ids.length;
  if(duplicateImports>submitted)throw new Error("Unexpected YNAB duplicate import count");
  return {submitted,processed:submitted-duplicateImports,duplicateImports,ynabReportedTransactionIds:data.transaction_ids.length};
}
