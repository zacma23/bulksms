import { readSheet } from 'read-excel-file/browser';
import writeXlsxFile, { type SheetData } from 'write-excel-file/browser';

export const E164_PHONE_REGEX = /^\+[1-9][0-9]{6,14}$/;

// Standard GSM-7 basic character set (Ethiopic/Amharic automatically triggers UCS-2)
const GSM7_REGEX =
  /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà]*$/;

export interface SmsSegmentMetrics {
  encoding: 'GSM-7' | 'UCS-2';
  charCount: number;
  segments: number;
  remainingInSegment: number;
  perSegmentLimit: number;
}

export function analyzeSmsMessage(message: string): SmsSegmentMetrics {
  const charCount = message.length;
  const isGsm = GSM7_REGEX.test(message);

  if (charCount === 0) {
    return {
      encoding: 'GSM-7',
      charCount: 0,
      segments: 0,
      remainingInSegment: 160,
      perSegmentLimit: 160,
    };
  }

  if (isGsm) {
    if (charCount <= 160) {
      return {
        encoding: 'GSM-7',
        charCount,
        segments: 1,
        remainingInSegment: 160 - charCount,
        perSegmentLimit: 160,
      };
    }
    const segments = Math.ceil(charCount / 153);
    return {
      encoding: 'GSM-7',
      charCount,
      segments,
      remainingInSegment: segments * 153 - charCount,
      perSegmentLimit: 153,
    };
  }

  // Unicode / UCS-2 (supports Amharic, Ge'ez, Arabic, emojis, etc.)
  if (charCount <= 70) {
    return {
      encoding: 'UCS-2',
      charCount,
      segments: 1,
      remainingInSegment: 70 - charCount,
      perSegmentLimit: 70,
    };
  }
  const segments = Math.ceil(charCount / 67);
  return {
    encoding: 'UCS-2',
    charCount,
    segments,
    remainingInSegment: segments * 67 - charCount,
    perSegmentLimit: 67,
  };
}

/**
 * Normalizes Ethiopian (+251) and international phone numbers to strict E.164 format.
 */
export function normalizePhoneNumber(rawInput: string, defaultEthiopia = true): string {
  let cleaned = String(rawInput || '').trim();
  if (!cleaned) return '';

  cleaned = cleaned.replace(/[\s\-().]/g, '');

  if (cleaned.startsWith('00')) {
    cleaned = `+${cleaned.slice(2)}`;
  }

  if (defaultEthiopia && !cleaned.startsWith('+')) {
    if (/^0[79]\d{8}$/.test(cleaned)) {
      cleaned = `+251${cleaned.slice(1)}`;
    } else if (/^[79]\d{8}$/.test(cleaned)) {
      cleaned = `+251${cleaned}`;
    } else if (/^251[79]\d{8}$/.test(cleaned)) {
      cleaned = `+${cleaned}`;
    } else if (/^[1-9]\d{7,14}$/.test(cleaned)) {
      cleaned = `+${cleaned}`;
    }
  } else if (!cleaned.startsWith('+') && /^[1-9]\d{7,14}$/.test(cleaned)) {
    cleaned = `+${cleaned}`;
  }

  return cleaned;
}

export function isValidE164Phone(phone: string): boolean {
  return E164_PHONE_REGEX.test(phone);
}

export function detectCarrierLabel(phone: string): string {
  if (phone.startsWith('+2519')) return 'Ethio Telecom (+251)';
  if (phone.startsWith('+2517')) return 'Safaricom Ethiopia (+251)';
  if (phone.startsWith('+251')) return 'Ethiopia (+251)';
  if (phone.startsWith('+254')) return 'Kenya (+254)';
  if (phone.startsWith('+1')) return 'North America (+1)';
  if (phone.startsWith('+44')) return 'UK (+44)';
  if (phone.startsWith('+971')) return 'UAE (+971)';
  return 'International';
}

export function renderPersonalizedMessage(
  template: string,
  recipient: { name?: string; phone: string }
): string {
  const fullName = (recipient.name || '').trim() || 'Valued Customer';
  const firstName = fullName.split(/\s+/)[0] || fullName;
  return template
    .replace(/\{name\}/gi, fullName)
    .replace(/\{first_name\}/gi, firstName)
    .replace(/\{phone\}/gi, recipient.phone);
}

export function buildIdempotencyKey(campaignId: string, phone: string, attempt = 0): string {
  const cleanPhone = phone.replace(/[^0-9]/g, '');
  const cleanCamp = campaignId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
  return `zacma_${cleanCamp}_${cleanPhone}_a${attempt}`;
}

export interface ParsedImportContact {
  name: string;
  phone: string;
  notes: string;
  valid: boolean;
  rawPhone: string;
}

function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',' || ch === ';') {
      row.push(cell.trim());
      cell = '';
    } else if (ch === '\r' && next === '\n') {
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else if (ch === '\n' || ch === '\r') {
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell.trim());
    rows.push(row);
  }

  return rows.filter((r) => r.some((v) => v.length > 0));
}

function extractContactsFromMatrix(
  matrix: string[][],
  defaultEthiopia: boolean
): ParsedImportContact[] {
  if (matrix.length === 0) return [];

  const firstRow = matrix[0].map((c) => c.trim().toLowerCase());
  const hasHeader = firstRow.some((h) =>
    /(name|phone|mobile|tel|number|msisdn|contact|customer|note)/.test(h)
  );

  const headers = hasHeader ? firstRow : [];
  const dataRows = hasHeader ? matrix.slice(1) : matrix;

  const findIndex = (patterns: RegExp[]): number => {
    for (const p of patterns) {
      const idx = headers.findIndex((h) => p.test(h));
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const phoneIdx = hasHeader
    ? findIndex([/^phone/, /mobile/, /tel/, /number/, /msisdn/, /contact/])
    : -1;
  const nameIdx = hasHeader
    ? findIndex([/^full.?name/, /^name/, /customer/, /client/, /first.?name/])
    : -1;
  const notesIdx = hasHeader ? findIndex([/note/, /remark/, /company/, /branch/, /city/]) : -1;

  const parsed: ParsedImportContact[] = [];

  for (const row of dataRows) {
    const rawPhone =
      (phoneIdx >= 0 ? row[phoneIdx] : '') ||
      row.find((v) => /^[\d+\-() ]{8,20}$/.test(v.trim())) ||
      '';

    if (!rawPhone.trim()) continue;

    const name =
      (nameIdx >= 0 ? row[nameIdx] : '') ||
      row.find(
        (v, idx) => idx !== phoneIdx && v.trim().length > 0 && !/^[\d+\-() ]{8,20}$/.test(v.trim())
      ) ||
      'Customer';
    const notes = (notesIdx >= 0 ? row[notesIdx] : '') || '';

    const normalized = normalizePhoneNumber(rawPhone, defaultEthiopia);
    parsed.push({
      name: name.trim().slice(0, 120) || 'Customer',
      phone: normalized,
      notes: notes.trim().slice(0, 300),
      valid: isValidE164Phone(normalized),
      rawPhone: rawPhone.trim(),
    });
  }

  return parsed;
}

export async function parseContactsSpreadsheet(
  file: File,
  defaultEthiopia = true
): Promise<ParsedImportContact[]> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.csv') || file.type === 'text/csv') {
    const text = await file.text();
    const matrix = parseCsvText(text);
    return extractContactsFromMatrix(matrix, defaultEthiopia);
  }

  if (lower.endsWith('.xlsx')) {
    const rows = await readSheet(file);
    const matrix = rows.map((row) => row.map((cell) => (cell == null ? '' : String(cell))));
    return extractContactsFromMatrix(matrix, defaultEthiopia);
  }

  throw new Error('Unsupported file format. Please upload an Excel (.xlsx) or CSV (.csv) file.');
}

function neutralizeCsvFormula(val: string): string {
  const str = String(val ?? '');
  if (/^[=+\-@\t\r]/.test(str) && !E164_PHONE_REGEX.test(str)) {
    return `'${str}`;
  }
  return str;
}

export async function exportRowsToExcel(
  rows: Record<string, string | number>[],
  fileName: string,
  sheetName = 'Sheet1'
): Promise<void> {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const data: SheetData = [
    headers.map((h) => ({ type: String, value: h, fontWeight: 'bold' as const })),
    ...rows.map((row) =>
      headers.map((h) => {
        const val = row[h] ?? '';
        if (typeof val === 'number') {
          return { type: Number, value: val };
        }
        return { type: String, value: neutralizeCsvFormula(String(val)) };
      })
    ),
  ];

  await writeXlsxFile(data, { sheet: sheetName.slice(0, 31) }).toFile(
    fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`
  );
}

export function exportRowsToCsv(
  rows: Record<string, string | number>[],
  fileName: string
): void {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const escapeCell = (val: string | number): string => {
    const s = typeof val === 'string' ? neutralizeCsvFormula(val) : String(val);
    if (/[",\n\r]/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const lines = [
    headers.map(escapeCell).join(','),
    ...rows.map((r) => headers.map((h) => escapeCell(r[h] ?? '')).join(',')),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName.endsWith('.csv') ? fileName : `${fileName}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function formatTimestamp(ts: { toDate?: () => Date } | string | null | undefined): string {
  if (!ts) return '—';
  let d: Date;
  if (typeof ts === 'string') {
    d = new Date(ts);
  } else if (typeof ts.toDate === 'function') {
    d = ts.toDate();
  } else {
    return '—';
  }
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}
