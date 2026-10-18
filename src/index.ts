import { Effect } from "effect";
import { decodeCsv, parseCsv } from "./csv.ts";
import { inspectXlsxEffect, previewXlsxEffect } from "./spreadsheet.ts";
import { processImportEffect } from "./import-handler.ts";
import { findSatispayAccountsEffect, type YnabEnv } from "./ynab.ts";

type Env = { UPLOAD_TOKEN:string } & YnabEnv;
const MAX_FILE_BYTES=4_000_000;
const MAX_REQUEST_BYTES=4_500_000;
const UPLOAD_PATHS=new Set(["/inspect","/preview","/prepare","/import"]);

class UploadError extends Error {
  readonly _tag="UploadError";
  readonly status:number;
  constructor(message:string,status=400){super(message);this.name="UploadError";this.status=status;}
}
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{
  status,
  headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}
});

/** Bounded upload reads: also protect requests without Content-Length. */
const readRequestBodyEffect=(request:Request)=>Effect.tryPromise({
  try:async()=>{
    const reader=request.body?.getReader();
    if(!reader)throw new UploadError("Missing request body");
    const chunks:Uint8Array[]=[];
    let total=0;
    while(true){
      const next=await reader.read();
      if(next.done)break;
      total+=next.value.byteLength;
      if(total>MAX_REQUEST_BYTES){
        await reader.cancel();
        throw new UploadError("Upload too large",413);
      }
      chunks.push(next.value);
    }
    const body=new Uint8Array(total);
    let offset=0;
    for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}
    return body;
  },
  catch:e=>e instanceof UploadError?e:new UploadError("Cannot read request")
});

const decodeMultipartEffect=(body:Uint8Array,contentType:string)=>Effect.tryPromise({
  try:async()=>{
    const copy=new Request("https://local.invalid/inspect",{
      method:"POST",headers:{"Content-Type":contentType},body:body.buffer as ArrayBuffer
    });
    const form=await copy.formData();
    const file=form.get("file");
    if(!(file instanceof Blob)) throw new UploadError("Missing form field 'file'. Use Request Body → File → Shortcut Input instead.");
    return {
      bytes:new Uint8Array(await file.arrayBuffer()),
      fileName:file instanceof File?file.name:"shared-file"
    };
  },
  catch:e=>e instanceof UploadError?e:new UploadError("Invalid multipart form. Use Request Body → File in Shortcuts.")
});

/** Request adapter: there is a single Effect runtime boundary per incoming request. */
export function handleRequestEffect(request:Request,env:Env) {
  return Effect.gen(function*(){
    const url=new URL(request.url);
    if(request.method==="GET" && url.pathname==="/health") return json({
      ok:true,service:"satispay-ynab-import",mode:"ready",formats:["xlsx","csv"],
      upload:["raw","multipart"],routes:["/inspect","/preview","/prepare","/import","/ynab/accounts"]
    });
    const listAccounts=request.method==="GET" && url.pathname==="/ynab/accounts";
    const upload=request.method==="POST" && UPLOAD_PATHS.has(url.pathname);
    if(!listAccounts && !upload) return json({ok:false,error:"Not found"},404);
    if(!env.UPLOAD_TOKEN || request.headers.get("Authorization")!=="Bearer "+env.UPLOAD_TOKEN) {
      return json({ok:false,error:"Unauthorized"},401);
    }
    if(listAccounts) {
      return yield* findSatispayAccountsEffect(env).pipe(
        Effect.map(accounts=>json({ok:true,...accounts})),
        Effect.catch(e=>Effect.succeed(json({ok:false,error:e.message},502)))
      );
    }
    if(url.pathname==="/import" && request.headers.get("X-Confirm-Import")!=="yes"){
      return json({ok:false,error:"Set X-Confirm-Import: yes to enable this request; no writes performed"},403);
    }
    const preview=url.pathname==="/preview";
    const importPath=url.pathname==="/import" || url.pathname==="/prepare";
    const contentType=request.headers.get("Content-Type")??"application/octet-stream";
    const contentLength=Number(request.headers.get("Content-Length")??"0");
    if(contentLength>MAX_REQUEST_BYTES) return json({ok:false,error:"Upload too large"},413);

    const requestBytes=yield* readRequestBodyEffect(request).pipe(
      Effect.map(bytes=>({ok:true as const,bytes})),
      Effect.catch(error=>Effect.succeed({ok:false as const,error}))
    );
    if(!requestBytes.ok) return json({ok:false,error:requestBytes.error.message},requestBytes.error.status);
    let bytes=requestBytes.bytes;
    let fileName="shared-file";
    if(contentType.toLowerCase().startsWith("multipart/form-data")){
      const multipart=yield* decodeMultipartEffect(bytes,contentType).pipe(
        Effect.map(result=>({ok:true as const,result})),
        Effect.catch(error=>Effect.succeed({ok:false as const,error}))
      );
      if(!multipart.ok) return json({ok:false,error:multipart.error.message},multipart.error.status);
      bytes=multipart.result.bytes;
      fileName=multipart.result.fileName;
    }else if(/application\/(json|x-www-form-urlencoded)/i.test(contentType)){
      return json({ok:false,error:"Set Shortcuts Request Body → File → Shortcut Input, not JSON or Form."},415);
    }
    if(bytes.length>MAX_FILE_BYTES)return json({ok:false,error:"File exceeds 4 MB"},413);
    if(bytes.length===0)return json({ok:false,error:"Empty file"},400);
    const xlsMagic=[0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1];
    if(fileName.toLowerCase().endsWith(".xls")||xlsMagic.every((v,i)=>bytes[i]===v)){
      return json({ok:false,error:"Legacy .xls not supported: export .xlsx"},415);
    }
    const xlsx=bytes.length>=4 && bytes[0]===0x50 && bytes[1]===0x4b && bytes[2]===0x03 && bytes[3]===0x04;
    if(xlsx){
      if(importPath){
        const result=yield* processImportEffect(url.pathname==="/import"?"import":"prepare",bytes.buffer as ArrayBuffer,env);
        return json(result.body,result.status);
      }
      if(preview) {
        return yield* previewXlsxEffect(bytes.buffer as ArrayBuffer).pipe(
          Effect.map(data=>json({ok:true,format:"xlsx",fileName,...data,imported:0,
            message:"Dry run only: nothing sent to YNAB."})),
          Effect.catch(()=>Effect.succeed(json({ok:false,error:"Cannot parse XLSX workbook. Check the exported Excel file."},422)))
        );
      }
      return yield* inspectXlsxEffect(bytes.buffer as ArrayBuffer).pipe(
        Effect.map(data=>json({ok:true,format:"xlsx",fileName,...data,imported:0,
          message:"Excel received and parsed. Nothing sent to YNAB."})),
        Effect.catch(()=>Effect.succeed(json({ok:false,error:"Cannot parse XLSX workbook. Check the exported Excel file."},422)))
      );
    }
    if(fileName.toLowerCase().endsWith(".xlsx")||contentType.toLowerCase().includes("spreadsheetml")){
      return json({ok:false,error:"Not a valid XLSX (ZIP signature missing)"},422);
    }
    if(preview||importPath)return json({ok:false,error:"Preview/import supports XLSX only"},415);
    return yield* Effect.try({
      try:()=>parseCsv(decodeCsv(bytes)),
      catch:e=>new UploadError(e instanceof Error?e.message:"CSV parse error",422)
    }).pipe(
      Effect.map(parsed=>json({ok:true,mode:"inspect-only",fileName,
        delimiter:parsed.delimiter==="\t"?"TAB":parsed.delimiter,
        columns:parsed.headers,format:"csv",rowCount:parsed.rows.length,imported:0,
        message:"CSV received and parsed. Nothing sent to YNAB."})),
      Effect.catch(e=>Effect.succeed(json({ok:false,error:e.message},e.status)))
    );
  });
}

export default {
  fetch(request:Request,env:Env):Promise<Response>{
    return Effect.runPromise(handleRequestEffect(request,env));
  }
};
