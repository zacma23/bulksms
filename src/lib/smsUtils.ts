import * as XLSX from 'xlsx';

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
 * Examples:
 * - 0911 22 33 44 -> +251911223344
 * - 0712-345-678 -> +251712345678
 * - 251911223344 -> +251911223344
 * - 00251911223344 -> +251911223344
 * - +1 (415) 555-0199 -> +14155550199
 */
export function normalizePhoneNumber(rawInput: string, defaultEthiopia = true): string {
  let cleaned = String(rawInput || '').trim();
  if (!cleaned) return '';

  // Remove spaces, dashes, dots, parentheses
  cleaned = cleaned.replace(/[\s\-().]/g, '');

  // Convert 00 international prefix to +
  if (cleaned.startsWith('00')) {
    cleaned = `+${cleaned.slice(2)}`;
  }

  // Handle Ethiopian local format (09XXXXXXXX or 07XXXXXXXX or 9XXXXXXXX / 7XXXXXXXX)
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

export async function parseContactsSpreadsheet(
  file: File,
  defaultEthiopia = true
): Promise<ParsedImportContact[]> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array', raw: false });
  const firstSheet = workbook.SheetNames[0];
  if (!firstSheet) return [];

  const sheet = workbook.Sheets[firstSheet];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: '',
    raw: false,
  });

  const parsed: ParsedImportContact[] = [];

  for (const row of rows) {
    const keys = Object.keys(row);
    const findCol = (patterns: RegExp[]): string => {
      for (const p of patterns) {
        const matchKey = keys.find((k) => p.test(k.trim().toLowerCase()));
        if (matchKey !== undefined && String(row[matchKey] ?? '').trim() !== '') {
          return String(row[matchKey]).trim();
        }
      }
      return '';
    };

    const rawPhone =
      findCol([/^phone/, /mobile/, /tel/, /number/, /msisdn/, /contact/]) ||
      // Fallback: pick first cell that looks like a phone number
      Object.values(row)
        .map((v) => String(v ?? '').trim())
        .find((v) => /^[\d+\-() ]{8,20}$/.test(v)) ||
      '';

    if (!rawPhone) continue;

    const name =
      findCol([/^full.?name/, /^name/, /customer/, /client/, /first.?name/]) || 'Customer';
    const notes = findCol([/note/, /remark/, /company/, /branch/, /city/]).slice(0, 300);

    const normalized = normalizePhoneNumber(rawPhone, defaultEthiopia);
    parsed.push({
      name: name.slice(0, 120),
      phone: normalized,
      notes,
      valid: isValidE164Phone(normalized),
      rawPhone,
    });
  }

  return parsed;
}

function neutralizeCsvFormula(val: string): string {
  const str = String(val ?? '');
  if (/^[=+\-@\t\r]/.test(str) && !E164_PHONE_REGEX.test(str)) {
    return `'${str}`;
  }
  return str;
}

export function exportRowsToExcel(
  rows: Record<string, string | number>[],
  fileName: string,
  sheetName = 'Sheet1'
): void {
  const sanitized = rows.map((row) => {
    const clean: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(row)) {
      clean[k] = typeof v === 'string' ? neutralizeCsvFormula(v) : v;
    }
    return clean;
  });

  const ws = XLSX.utils.json_to_sheet(sanitized);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  XLSX.writeFile(wb, fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`);
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
