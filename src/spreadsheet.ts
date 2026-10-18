/** Inspect first worksheet; never return actual transaction rows. */
export type SheetCell = string | number | boolean | Date | null | undefined;
export function summarizeSheet(rows: SheetCell[][]) {
  const nonEmpty = rows.filter(row => row.some(value => value !== null && value !== undefined && String(value).trim() !== ""));
  if (!nonEmpty.length) throw new Error("Empty worksheet");
  const [header, ...body] = nonEmpty;
  if (header.length < 2) throw new Error("Expected at least two columns");
  return {
    columns: header.map((value, index) => String(value ?? `Column ${index + 1}`)),
    rowCount: body.length,
    sheet: 1
  };
}
export async function inspectXlsx(file: ArrayBuffer) {
  const { readSheet } = await import("read-excel-file/universal");
  const rows = await readSheet(file);
  return summarizeSheet(rows);
}
