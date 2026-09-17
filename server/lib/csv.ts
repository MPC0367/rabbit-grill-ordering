// CSV read/write. Output is UTF-8 with a BOM (so Excel shows Thai correctly)
// and neutralises spreadsheet formula injection: any cell starting with
// = + - @ TAB or CR is prefixed with an apostrophe.

export interface CsvColumn<T> {
  key: string;
  header: string;
  value: (row: T) => string | number | boolean | null | undefined;
}

const FORMULA = /^[=+\-@\t\r]/;

export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
  // Numbers are safe as numbers; strings that look like formulas are not.
  if (typeof value === 'string' && FORMULA.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** CSV text. `header: false` and `bom: false` produce a continuation chunk for a streamed file. */
export function toCsv<T>(rows: T[], columns: CsvColumn<T>[], opts: { bom?: boolean; header?: boolean } = {}): string {
  const lines = opts.header === false ? [] : [columns.map((c) => csvCell(c.header)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(c.value(r))).join(','));
  if (lines.length === 0) return '';
  return `${opts.bom === false ? '' : '﻿'}${lines.join('\r\n')}\r\n`;
}

/** RFC 4180 parser: quoted fields, escaped quotes, CRLF/LF, optional BOM. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Parse into objects keyed by the header row (headers trimmed, lower-cased). */
export function parseCsvObjects(text: string): { headers: string[]; rows: Array<Record<string, string>> } {
  const [head, ...body] = parseCsv(text);
  const headers = (head ?? []).map((h) => h.trim().toLowerCase());
  return {
    headers,
    rows: body.map((cells) => Object.fromEntries(headers.map((h, i) => [h, (cells[i] ?? '').trim()]))),
  };
}

export function csvResponseHeaders(filename: string): Record<string, string> {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, '_');
  return {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${safe}"`,
    'Cache-Control': 'no-store',
  };
}
