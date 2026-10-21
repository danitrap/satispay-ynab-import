import { observeOperation } from "./telemetry.ts";
import { Data, Effect, Redacted, Stream } from "effect";
import { AppConfig, type AppEnv } from "./config.ts";
import { decodeCsv, parseCsv } from "./csv.ts";
import { inspectXlsxEffect, previewXlsxEffect } from "./spreadsheet.ts";
import { processImportEffect } from "./import-handler.ts";
import type { YnabFailure } from "./errors.ts";
import { findAccountsEffect, requestLiveLayer } from "./ynab-service.ts";

type Env = AppEnv;
const MAX_FILE_BYTES = 4_000_000;
const MAX_REQUEST_BYTES = 4_500_000;
const UPLOAD_PATHS = new Set(["/inspect", "/preview", "/prepare", "/import"]);

class UploadError extends Data.TaggedError("UploadError")<{
  readonly message: string;
  readonly status: number;
}> {
  constructor(message: string, status = 400) {
    super({ message, status });
  }
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });

const isImportRequest = (request: Request) =>
  ["/prepare", "/import"].includes(new URL(request.url).pathname);

function ynabFailureStatus(error: YnabFailure): number {
  switch (error._tag) {
    case "ConfigurationError":
      return 409;
    case "YnabWriteDisabledError":
      return 403;
    case "YnabAccountError":
    case "YnabImportRejectedError":
      return 422;
    default:
      return 502;
  }
}
const ynabFailureResponse = (error: YnabFailure) =>
  Effect.succeed(json({ ok: false, error: error.message }, ynabFailureStatus(error)));

/** Bounded upload reads: also protect requests without Content-Length. */
const readRequestBodyEffect = Effect.fn("satispay.upload")(
  function* (request: Request) {
    const body = request.body;
    if (!body) return yield* Effect.fail(new UploadError("Missing request body"));
    let total = 0;
    const chunks = yield* Effect.acquireUseRelease(
      Effect.succeed(body),
      (stream) =>
        Stream.fromReadableStream({
          evaluate: () => stream,
          releaseLockOnEnd: true,
          onError: () => new UploadError("Cannot read request"),
        }).pipe(
          Stream.mapEffect((chunk) =>
            Effect.suspend(() => {
              total += chunk.byteLength;
              return total > MAX_REQUEST_BYTES
                ? Effect.fail(new UploadError("Upload too large", 413))
                : Effect.succeed(chunk);
            }),
          ),
          Stream.runCollect,
        ),
      (stream) => Effect.promise(() => stream.cancel().catch(() => undefined)),
    );
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  },
  Effect.timeoutOrElse({
    duration: "30 seconds",
    orElse: () => Effect.fail(new UploadError("Upload timed out", 408)),
  }),
  observeOperation("upload"),
);

const decodeMultipartEffect = (body: Uint8Array, contentType: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      const copy = new Request("https://local.invalid/inspect", {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: body.buffer as ArrayBuffer,
        signal,
      });
      const form = await copy.formData();
      const file = form.get("file");
      if (!(file instanceof Blob))
        throw new UploadError(
          "Missing form field 'file'. Use Request Body → File → Shortcut Input instead.",
        );
      return {
        bytes: new Uint8Array(await file.arrayBuffer()),
        fileName: file instanceof File ? file.name : "shared-file",
      };
    },
    catch: (e) =>
      e instanceof UploadError
        ? e
        : new UploadError("Invalid multipart form. Use Request Body → File in Shortcuts."),
  });

/** Request adapter: there is a single Effect runtime boundary per incoming request. */
export function handleRequestEffect(request: Request) {
  return Effect.gen(function* () {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health")
      return json({
        ok: true,
        service: "satispay-ynab-import",
        mode: "ready",
        formats: ["xlsx", "csv"],
        upload: ["raw", "multipart"],
        routes: ["/inspect", "/preview", "/prepare", "/import", "/ynab/accounts"],
      });
    const listAccounts = request.method === "GET" && url.pathname === "/ynab/accounts";
    const upload = request.method === "POST" && UPLOAD_PATHS.has(url.pathname);
    if (!listAccounts && !upload) return json({ ok: false, error: "Not found" }, 404);
    const config = yield* AppConfig;
    const uploadToken = yield* config.uploadToken.pipe(
      Effect.catchTag("ConfigurationError", () =>
        Effect.fail(new UploadError("Unauthorized", 401)),
      ),
    );
    if (request.headers.get("Authorization") !== "Bearer " + Redacted.value(uploadToken)) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }
    if (listAccounts) {
      const accounts = yield* findAccountsEffect;
      return json({ ok: true, ...accounts });
    }
    if (url.pathname === "/import" && request.headers.get("X-Confirm-Import") !== "yes") {
      return json(
        {
          ok: false,
          error: "Set X-Confirm-Import: yes to enable this request; no writes performed",
        },
        403,
      );
    }
    const preview = url.pathname === "/preview";
    const importPath = url.pathname === "/import" || url.pathname === "/prepare";
    const contentType = request.headers.get("Content-Type") ?? "application/octet-stream";
    const contentLength = Number(request.headers.get("Content-Length") ?? "0");
    if (contentLength > MAX_REQUEST_BYTES)
      return json({ ok: false, error: "Upload too large" }, 413);

    let bytes = yield* readRequestBodyEffect(request);
    let fileName = "shared-file";
    if (contentType.toLowerCase().startsWith("multipart/form-data")) {
      const multipart = yield* decodeMultipartEffect(bytes, contentType);
      bytes = multipart.bytes;
      fileName = multipart.fileName;
    } else if (/application\/(json|x-www-form-urlencoded)/i.test(contentType)) {
      return json(
        {
          ok: false,
          error: "Set Shortcuts Request Body → File → Shortcut Input, not JSON or Form.",
        },
        415,
      );
    }
    if (bytes.length > MAX_FILE_BYTES) return json({ ok: false, error: "File exceeds 4 MB" }, 413);
    if (bytes.length === 0) return json({ ok: false, error: "Empty file" }, 400);
    const xlsMagic = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    if (fileName.toLowerCase().endsWith(".xls") || xlsMagic.every((v, i) => bytes[i] === v)) {
      return json({ ok: false, error: "Legacy .xls not supported: export .xlsx" }, 415);
    }
    const xlsx =
      bytes.length >= 4 &&
      bytes[0] === 0x50 &&
      bytes[1] === 0x4b &&
      bytes[2] === 0x03 &&
      bytes[3] === 0x04;
    if (xlsx) {
      if (importPath) {
        const result = yield* processImportEffect(
          url.pathname === "/import" ? "import" : "prepare",
          bytes.buffer as ArrayBuffer,
        );
        if (result._tag === "ImportPrepared") {
          return json({
            ok: true,
            mode: "import-preview",
            ...result.summary,
            imported: 0,
            message: "No transactions have been sent to YNAB",
          });
        }
        return json({
          ok: true,
          mode: "import-completed",
          ...result.summary,
          ...result.result,
          imported: result.result.processed,
          message:
            "YNAB processed the batch (new or matched transactions). Review and reconcile Satispay in YNAB.",
        });
      }
      if (preview) {
        const data = yield* previewXlsxEffect(bytes.buffer as ArrayBuffer);
        return json({
          ok: true,
          format: "xlsx",
          fileName,
          ...data,
          imported: 0,
          message: "Dry run only: nothing sent to YNAB.",
        });
      }
      const data = yield* inspectXlsxEffect(bytes.buffer as ArrayBuffer);
      return json({
        ok: true,
        format: "xlsx",
        fileName,
        ...data,
        imported: 0,
        message: "Excel received and parsed. Nothing sent to YNAB.",
      });
    }
    if (
      fileName.toLowerCase().endsWith(".xlsx") ||
      contentType.toLowerCase().includes("spreadsheetml")
    ) {
      return json({ ok: false, error: "Not a valid XLSX (ZIP signature missing)" }, 422);
    }
    if (preview || importPath)
      return json({ ok: false, error: "Preview/import supports XLSX only" }, 415);
    const parsed = yield* Effect.try({
      try: () => parseCsv(decodeCsv(bytes)),
      catch: (e) => new UploadError(e instanceof Error ? e.message : "CSV parse error", 422),
    });
    return json({
      ok: true,
      mode: "inspect-only",
      fileName,
      delimiter: parsed.delimiter === "\t" ? "TAB" : parsed.delimiter,
      columns: parsed.headers,
      format: "csv",
      rowCount: parsed.rows.length,
      imported: 0,
      message: "CSV received and parsed. Nothing sent to YNAB.",
    });
  }).pipe(
    Effect.catchTags({
      UploadError: (error) =>
        Effect.succeed(json({ ok: false, error: error.message }, error.status)),
      ConfigurationError: (error) =>
        Effect.succeed(
          json(
            {
              ok: false,
              error: error.message,
              ...(isImportRequest(request) ? { imported: 0 } : {}),
            },
            409,
          ),
        ),
      WorkbookError: (error) =>
        Effect.succeed(
          json(
            {
              ok: false,
              error: error.message,
              ...(isImportRequest(request) ? { imported: 0 } : {}),
            },
            422,
          ),
        ),
      ImportPlanError: (error) =>
        Effect.succeed(json({ ok: false, error: error.message, imported: 0 }, 422)),
      ImportBlockedError: (error) =>
        Effect.succeed(
          json(
            {
              ok: false,
              mode: "import-blocked",
              ...error.summary,
              imported: 0,
              error: error.message,
            },
            422,
          ),
        ),
      ImportFailedError: (error) =>
        Effect.succeed(
          json(
            { ok: false, mode: "import-failed", ...error.summary, error: error.message },
            ynabFailureStatus(error.reason),
          ),
        ),
      YnabWriteDisabledError: ynabFailureResponse,
      YnabImportRejectedError: ynabFailureResponse,
      YnabAccountError: ynabFailureResponse,
      YnabError: ynabFailureResponse,
      YnabTransportError: ynabFailureResponse,
      YnabHttpError: ynabFailureResponse,
      YnabResponseError: ynabFailureResponse,
      YnabImportUncertainError: ynabFailureResponse,
    }),
  );
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return Effect.runPromise(
      handleRequestEffect(request).pipe(Effect.provide(requestLiveLayer(env))),
      { signal: request.signal },
    );
  },
};
