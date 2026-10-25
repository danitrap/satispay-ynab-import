import { listYnabAccounts } from "../application/list-ynab-accounts.ts";
import { decodeCsv, parseCsv } from "../csv.ts";
import { processImportEffect } from "../import-handler.ts";
import { inspectXlsxEffect, previewXlsxEffect } from "../spreadsheet.ts";
import {
  presentAccounts,
  presentConfirmRequired,
  presentImportCompleted,
  presentInspectCsv,
  presentInspectXlsx,
  presentPreparedImport,
  presentPreview,
  presentRouteFailure,
  type PresentedFailure,
  type PresentedRoute,
} from "./presenters.ts";
import { fileBuffer, readUpload, sniffUpload, uploadError, type UploadBody } from "./upload.ts";
import { Effect } from "effect";

/**
 * Decode the upload, call the use case, and hand its result to a presenter.
 * Response bodies and status codes stay in the presenters.
 */

const respond = <A, E extends PresentedFailure, R>(
  effect: Effect.Effect<A, E, R>,
  route: PresentedRoute,
  onSuccess: (value: A) => Response,
) =>
  effect.pipe(
    Effect.map(onSuccess),
    Effect.catch((error) => Effect.succeed(presentRouteFailure(error, route))),
  );

const readXlsxUpload = (request: Request) =>
  readUpload(request).pipe(
    Effect.flatMap((upload) => {
      const sniffed = sniffUpload(upload);
      if (sniffed._tag === "Xlsx") return Effect.succeed(upload);
      if (sniffed._tag === "LegacyXls") return Effect.fail(uploadError("LegacyXls"));
      if (sniffed._tag === "NamedXlsx") return Effect.fail(uploadError("InvalidXlsx"));
      return Effect.fail(uploadError("XlsxOnly"));
    }),
  );

const inspectUpload = (upload: UploadBody) =>
  Effect.gen(function* () {
    const sniffed = sniffUpload(upload);
    if (sniffed._tag === "LegacyXls") return yield* uploadError("LegacyXls");
    if (sniffed._tag === "NamedXlsx") return yield* uploadError("InvalidXlsx");
    if (sniffed._tag === "Xlsx") {
      const summary = yield* inspectXlsxEffect(fileBuffer(upload));
      return presentInspectXlsx(summary, upload.fileName);
    }
    const parsed = yield* Effect.try({
      try: () => parseCsv(decodeCsv(upload.bytes)),
      catch: (error) => uploadError("CsvParse", error instanceof Error ? error.message : undefined),
    });
    return presentInspectCsv(parsed, upload.fileName);
  });

export const accountsController = () => respond(listYnabAccounts, "accounts", presentAccounts);

export const inspectController = (request: Request) =>
  respond(
    readUpload(request).pipe(Effect.flatMap(inspectUpload)),
    "inspect",
    (response) => response,
  );

export const previewController = (request: Request) =>
  respond(
    readXlsxUpload(request).pipe(
      Effect.flatMap((upload) =>
        previewXlsxEffect(fileBuffer(upload)).pipe(
          Effect.map((summary) => ({ summary, fileName: upload.fileName })),
        ),
      ),
    ),
    "preview",
    ({ summary, fileName }) => presentPreview(summary, fileName),
  );

export const prepareController = (request: Request) =>
  respond(
    readXlsxUpload(request).pipe(
      Effect.flatMap((upload) =>
        processImportEffect("prepare", fileBuffer(upload)).pipe(
          Effect.flatMap((result) =>
            result._tag === "ImportPrepared"
              ? Effect.succeed(result.summary)
              : Effect.die("prepare submitted an import"),
          ),
        ),
      ),
    ),
    "prepare",
    presentPreparedImport,
  );

export const importController = (request: Request) => {
  if (request.headers.get("X-Confirm-Import") !== "yes") {
    return Effect.succeed(presentConfirmRequired());
  }
  return respond(
    readXlsxUpload(request).pipe(
      Effect.flatMap((upload) =>
        processImportEffect("import", fileBuffer(upload)).pipe(
          Effect.flatMap((result) =>
            result._tag === "ImportCompleted"
              ? Effect.succeed(result)
              : Effect.die("import did not submit the prepared import"),
          ),
        ),
      ),
    ),
    "import",
    ({ summary, outcome }) => presentImportCompleted(summary, outcome),
  );
};
