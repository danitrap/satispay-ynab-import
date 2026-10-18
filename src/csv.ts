/** Minimal RFC-4180-style parser for inspection of single, small CSV exports. */
export type ParsedCsv = { delimiter: string; headers: string[]; rows: string[][] };

export function decodeCsv(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(bytes).replace(/^\uFEFF/, "");
  }
}

function countDelimiter(line: string, delimiter: string): number {
  let inQuotes = false;
  let count = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      if (inQuotes && line[i + 1] === '"') i++;
      else inQuotes = !inQuotes;
    } else if (!inQuotes && line[i] === delimiter) count++;
  }
  return count;
}

export function detectDelimiter(text: string): string {
  // First nonempty physical line normally contains column headings.
  const headerLine = text.split(/\r?\n/).find((s) => s.trim() !== "") ?? "";
  const choices = [";", ",", "\t"];
  return choices.sort((a, b) => countDelimiter(headerLine, b) - countDelimiter(headerLine, a))[0];
}

export function parseCsv(text: string, delimiter = detectDelimiter(text)): ParsedCsv {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let justClosedQuote = false;

  function commitField() {
    record.push(field);
    field = "";
    justClosedQuote = false;
  }
  function commitRecord() {
    commitField();
    if (record.some((value) => value.trim() !== "")) records.push(record);
    record = [];
  }

  const input = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"') {
        if (input[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; justClosedQuote = true; }
      } else field += c;
    } else if (c === '"' && field === "" && !justClosedQuote) {
      quoted = true;
    } else if (c === delimiter) {
      commitField();
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && input[i + 1] === "\n") i++;
      commitRecord();
    } else if (justClosedQuote && c !== " " && c !== "\t") {
      throw new Error("Invalid CSV: characters after closing quote");
    } else if (!justClosedQuote) {
      field += c;
    }
  }
  if (quoted) throw new Error("Invalid CSV: unclosed quoted field");
  if (record.length || field.length || justClosedQuote) commitRecord();
  if (!records.length) throw new Error("CSV is empty");
  const [headers, ...rows] = records;
  if (headers.length < 2) throw new Error("At least two columns expected; please check delimiter");
  if (rows.some((row) => row.length !== headers.length)) {
    throw new Error("Some CSV records have a different number of fields from the header");
  }
  if (new Set(headers).size !== headers.length) {
    throw new Error("CSV has duplicate column names");
  }
  return { delimiter, headers, rows };
}
