import * as XLSX from "xlsx";

/** Builds an .xlsx buffer from { sheetName: rows[][] }. */
export const makeWorkbook = (sheets) => {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
};
