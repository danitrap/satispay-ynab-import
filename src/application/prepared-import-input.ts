export type PreparedImportInputReason =
  "InvalidCutoff" | "EmptyWorkbook" | "MissingColumns" | "MissingIdColumn" | "AmountOverflow";

/** A prepared import or preview could not be built from the decoded rows. */
export class PreparedImportInputError extends Error {
  readonly _tag = "PreparedImportInputError";
  readonly reason: PreparedImportInputReason;
  constructor(reason: PreparedImportInputReason) {
    super(reason);
    this.reason = reason;
  }
}
