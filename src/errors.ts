import { Data } from "effect";

/** The workbook decoder could not read the upload. Created at the workbook boundary. */
export class WorkbookError extends Data.TaggedError("WorkbookError")<{ readonly message: string }> {
  constructor(message: string) {
    super({ message });
  }
}
