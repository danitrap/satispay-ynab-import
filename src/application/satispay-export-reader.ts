import type { SatispayExportRead } from "../domain/satispay-movement.ts";
import type { WorkbookError } from "./workbook-reader.ts";
import { Context, Data, Effect } from "effect";

export type SatispayExportHeaderReason =
  "EmptyExport" | "MissingColumns" | "MissingMovementIdentifier";

/** The file is not a readable Satispay export. Row problems are not header errors. */
export class SatispayExportHeaderError extends Data.TaggedError("SatispayExportHeaderError")<{
  readonly reason: SatispayExportHeaderReason;
}> {}

/** Port: read one Satispay export into typed movements, or fail with a header error. */
export class SatispayExportReader extends Context.Service<
  SatispayExportReader,
  {
    readonly read: (
      file: ArrayBuffer,
    ) => Effect.Effect<SatispayExportRead, SatispayExportHeaderError | WorkbookError>;
  }
>()("satispay/SatispayExportReader") {}
