import { inspectXlsxEffect } from "../application/inspect.ts";
import { listYnabAccounts } from "../application/list-ynab-accounts.ts";
import { previewXlsxEffect } from "../application/preview.ts";
import { processImportEffect } from "../application/process-import.ts";
import {
  presentAccounts,
  presentConfirmRequired,
  presentImportCompleted,
  presentInspectXlsx,
  presentPreparedImport,
  presentPreview,
  presentRouteFailure,
  type PresentedFailure,
  type PresentedRoute,
} from "./presenters.ts";
import { fileBuffer, readUpload, sniffUpload, uploadError } from "./upload.ts";
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

export const accountsController = () => respond(listYnabAccounts, "accounts", presentAccounts);

export const inspectController = (request: Request) =>
  respond(
    readXlsxUpload(request).pipe(
      Effect.flatMap((upload) =>
        inspectXlsxEffect(fileBuffer(upload)).pipe(
          Effect.map((summary) => ({ summary, fileName: upload.fileName })),
        ),
      ),
    ),
    "inspect",
    ({ summary, fileName }) => presentInspectXlsx(summary, fileName),
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
