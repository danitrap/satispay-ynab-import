/** Expected structural worksheet failures, separate from programming defects. */
export class WorksheetInputError extends Error {
  readonly _tag = "WorksheetInputError";
  readonly reason: "EmptyWorksheet" | "InsufficientColumns" | "MissingColumns" | "MissingIdColumn";
  constructor(reason: WorksheetInputError["reason"]) {
    super(reason);
    this.reason = reason;
  }
}
