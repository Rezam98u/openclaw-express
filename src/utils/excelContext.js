import * as XLSX from "xlsx";

const DEFAULT_MAX_CHARS = 8000;

/**
 * @param {Buffer} buffer
 * @param {object} [opts]
 * @param {string} [opts.sheetName]
 * @param {number} [opts.maxChars]
 * @returns {{ text: string; meta: { sheetName: string; rowCount: number; colCount: number; charCount: number; truncated: boolean; maxChars: number; sourceBytes: number } }}
 */
export function bufferToExcelContext(buffer, opts = {}) {
  const maxChars =
    typeof opts.maxChars === "number" && opts.maxChars > 0
      ? opts.maxChars
      : Number(process.env.MAX_EXCEL_CONTEXT_CHARS) > 0
        ? Number(process.env.MAX_EXCEL_CONTEXT_CHARS)
        : DEFAULT_MAX_CHARS;

  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetNames = workbook.SheetNames;
  if (!sheetNames.length) {
    return {
      text: "",
      meta: {
        sheetName: "",
        rowCount: 0,
        colCount: 0,
        charCount: 0,
        truncated: false,
        maxChars,
        sourceBytes: buffer.length,
      },
    };
  }

  let sheetName = sheetNames[0];
  if (
    typeof opts.sheetName === "string" &&
    opts.sheetName.trim() &&
    workbook.Sheets[opts.sheetName.trim()]
  ) {
    sheetName = opts.sheetName.trim();
  }

  const sheet = workbook.Sheets[sheetName];
  const tsv = XLSX.utils.sheet_to_csv(sheet, { FS: "\t", blankrows: false });
  const range = sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]) : null;
  const rowCount = range ? range.e.r - range.s.r + 1 : 0;
  const colCount = range ? range.e.c - range.s.c + 1 : 0;

  let text = tsv;
  let truncated = false;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }

  return {
    text,
    meta: {
      sheetName,
      rowCount,
      colCount,
      charCount: text.length,
      truncated,
      maxChars,
      sourceBytes: buffer.length,
    },
  };
}
