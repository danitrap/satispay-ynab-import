import { observeOperation } from "../telemetry.ts";
import { Data, Effect, Stream } from "effect";

const MAX_FILE_BYTES = 4_000_000;
const MAX_REQUEST_BYTES = 4_500_000;
const XLS_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export type UploadReason =
  | "MissingBody"
  | "Unreadable"
  | "RequestTooLarge"
  | "TimedOut"
  | "MissingFileField"
  | "InvalidMultipart"
  | "JsonOrFormBody"
  | "FileTooLarge"
  | "EmptyFile"
  | "LegacyXls"
  | "InvalidXlsx"
  | "XlsxOnly"
  | "CsvParse";

const UPLOAD_MESSAGES: Record<UploadReason, string> = {
  MissingBody: "Missing request body",
  Unreadable: "Cannot read request",
  RequestTooLarge: "Upload too large",
  TimedOut: "Upload timed out",
  MissingFileField: "Missing form field 'file'. Use Request Body → File → Shortcut Input instead.",
  InvalidMultipart: "Invalid multipart form. Use Request Body → File in Shortcuts.",
  JsonOrFormBody: "Set Shortcuts Request Body → File → Shortcut Input, not JSON or Form.",
  FileTooLarge: "File exceeds 4 MB",
  EmptyFile: "Empty file",
  LegacyXls: "Legacy .xls not supported: export .xlsx",
  InvalidXlsx: "Not a valid XLSX (ZIP signature missing)",
  XlsxOnly: "Preview/import supports XLSX only",
  CsvParse: "CSV parse error",
};

/** The upload could not be decoded. The presenter chooses the HTTP status. */
export class UploadError extends Data.TaggedError("UploadError")<{
  readonly reason: UploadReason;
  readonly message: string;
}> {}

export const uploadError = (reason: UploadReason, message = UPLOAD_MESSAGES[reason]) =>
  new UploadError({ reason, message });

export type UploadBody = {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly contentType: string;
};

export type SniffedUpload =
  | { readonly _tag: "Xlsx" }
  | { readonly _tag: "LegacyXls" }
  | { readonly _tag: "NamedXlsx" }
  | { readonly _tag: "Other" };

/** Bounded upload reads: also protect requests without Content-Length. */
const readRequestBodyEffect = Effect.fn("satispay.upload")(
  function* (request: Request) {
    const body = request.body;
    if (!body) return yield* uploadError("MissingBody");
    let total = 0;
    const chunks = yield* Effect.acquireUseRelease(
      Effect.succeed(body),
      (stream) =>
        Stream.fromReadableStream({
          evaluate: () => stream,
          releaseLockOnEnd: true,
          onError: () => uploadError("Unreadable"),
        }).pipe(
          Stream.mapEffect((chunk) =>
            Effect.suspend(() => {
              total += chunk.byteLength;
              return total > MAX_REQUEST_BYTES
                ? Effect.fail(uploadError("RequestTooLarge"))
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
    orElse: () => Effect.fail(uploadError("TimedOut")),
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
      if (!(file instanceof Blob)) throw uploadError("MissingFileField");
      return {
        bytes: new Uint8Array(await file.arrayBuffer()),
        fileName: file instanceof File ? file.name : "shared-file",
      };
    },
    catch: (error) => (error instanceof UploadError ? error : uploadError("InvalidMultipart")),
  });

/** Read the body without classifying it. Format rules stay with the controller. */
export const readUpload = (request: Request) =>
  Effect.gen(function* () {
    const contentType = request.headers.get("Content-Type") ?? "application/octet-stream";
    const contentLength = Number(request.headers.get("Content-Length") ?? "0");
    if (contentLength > MAX_REQUEST_BYTES) return yield* uploadError("RequestTooLarge");
    let bytes = yield* readRequestBodyEffect(request);
    let fileName = "shared-file";
    if (contentType.toLowerCase().startsWith("multipart/form-data")) {
      const multipart = yield* decodeMultipartEffect(bytes, contentType);
      bytes = multipart.bytes;
      fileName = multipart.fileName;
    } else if (/application\/(json|x-www-form-urlencoded)/i.test(contentType)) {
      return yield* uploadError("JsonOrFormBody");
    }
    if (bytes.length > MAX_FILE_BYTES) return yield* uploadError("FileTooLarge");
    if (bytes.length === 0) return yield* uploadError("EmptyFile");
    return { bytes, fileName, contentType } satisfies UploadBody;
  });

/** ZIP workbooks, legacy `.xls`, and a name that claims to be xlsx. */
export const sniffUpload = (upload: UploadBody): SniffedUpload => {
  const name = upload.fileName.toLowerCase();
  const bytes = upload.bytes;
  if (name.endsWith(".xls") || XLS_MAGIC.every((value, index) => bytes[index] === value)) {
    return { _tag: "LegacyXls" };
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  ) {
    return { _tag: "Xlsx" };
  }
  if (name.endsWith(".xlsx") || upload.contentType.toLowerCase().includes("spreadsheetml")) {
    return { _tag: "NamedXlsx" };
  }
  return { _tag: "Other" };
};

export const fileBuffer = (upload: UploadBody): ArrayBuffer => upload.bytes.buffer as ArrayBuffer;
