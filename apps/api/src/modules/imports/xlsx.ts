import ExcelJS from 'exceljs';

export interface ParsedSheet {
  headers: string[];
  rows: Array<{ rowNumber: number; values: Record<string, string | null> }>;
}

/** "Legal Name" → legal_name */
export function normalizeHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function cellText(v: ExcelJS.CellValue): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('richText' in v)
      return (
        v.richText
          .map((t) => t.text)
          .join('')
          .trim() || null
      );
    if ('text' in v && typeof v.text === 'string') return v.text.trim() || null; // hyperlink
    if ('result' in v && v.result !== undefined) return cellText(v.result as ExcelJS.CellValue); // formula
    if ('error' in v) return null;
  }
  return null;
}

/**
 * Reads the first worksheet. Row 1 is the header row; fully empty rows are skipped.
 * Formulas contribute only their cached result (never evaluated).
 */
export async function parseWorkbook(bytes: Buffer, maxRows: number): Promise<ParsedSheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('The workbook has no worksheets');
  const headerRow = ws.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, col) => {
    headers[col] = normalizeHeader(String(cellText(cell.value) ?? ''));
  });
  const rows: ParsedSheet['rows'] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const values: Record<string, string | null> = {};
    let any = false;
    headers.forEach((h, col) => {
      if (!h) return;
      const t = cellText(row.getCell(col).value);
      values[h] = t;
      if (t !== null) any = true;
    });
    if (!any) continue;
    rows.push({ rowNumber: r, values });
    if (rows.length > maxRows) throw new Error(`Too many rows: the limit is ${maxRows} per import`);
  }
  return { headers: headers.filter(Boolean), rows };
}
