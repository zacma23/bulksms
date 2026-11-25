import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IS_PROD = process.env.NODE_ENV === 'production';

function resolveServerPort(): number {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      const parsed = Number(args[i + 1]);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    if (args[i].startsWith('--port=')) {
      const parsed = Number(args[i].slice('--port='.length));
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  if (IS_PROD && process.env.PORT) {
    const parsed = Number(process.env.PORT);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 3000;
}

const PORT = resolveServerPort();
const BOOTSTRAP_ADMIN_EMAIL = 'zekimuluken@gmail.com';

// Load Firebase projectId and databaseId from provisioned config
const firebaseConfigPath = path.resolve(__dirname, 'firebase-applet-config.json');
let FIREBASE_PROJECT_ID = '';
let FIRESTORE_DATABASE_ID = '(default)';
try {
  const rawCfg = fs.readFileSync(firebaseConfigPath, 'utf-8');
  const parsed = JSON.parse(rawCfg) as { projectId?: string; firestoreDatabaseId?: string };
  FIREBASE_PROJECT_ID = parsed.projectId || '';
  FIRESTORE_DATABASE_ID = parsed.firestoreDatabaseId || '(default)';
} catch (err) {
  console.error('Failed to read firebase-applet-config.json:', err);
}

// Official Google Firebase public JWKS for RS256 ID token verification (no IAM required)
const FIREBASE_JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com')
);

// SSRF-safe base URL validator for SMS.io / SMS.to endpoints
function validateGatewayBaseUrl(rawUrl: string | undefined, fallback: string): string {
  const candidate = (rawUrl || fallback).trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:') {
      throw new Error('Gateway URL must use HTTPS');
    }
    const host = parsed.hostname.toLowerCase();
    const blocked =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '0.0.0.0' ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      host.startsWith('169.254.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
      host.endsWith('.local') ||
      host.endsWith('.internal');
    if (blocked) {
      throw new Error('Blocked private gateway host');
    }
    return parsed.origin;
  } catch {
    return fallback;
  }
}

const SMS_API_BASE = validateGatewayBaseUrl(process.env.SMS_IO_API_BASE_URL, 'https://api.sms.to');
const SMS_AUTH_BASE = validateGatewayBaseUrl(process.env.SMS_IO_AUTH_BASE_URL, 'https://auth.sms.to');
const DEFAULT_SENDER_ID = (process.env.SMS_IO_SENDER_ID || 'ZACMA').trim().slice(0, 11) || 'ZACMA';

const E164_REGEX = /^\+[1-9][0-9]{6,14}$/;
const SENDER_ID_REGEX = /^[a-zA-Z0-9 +\-_.]{1,15}$/;
const IDEMPOTENCY_REGEX = /^[a-zA-Z0-9_\-:.]{8,128}$/;

interface VerifiedUser {
  uid: string;
  email: string;
  emailVerified: boolean;
  role: 'admin' | 'staff';
  canSendBulk: boolean;
}

interface AuthenticatedRequest extends express.Request {
  authUser?: VerifiedUser;
}

interface CachedDispatch {
  timestamp: number;
  result: SendResultPayload;
}

interface SendResultPayload {
  success: boolean;
  status: 'sent' | 'pending' | 'delivered' | 'failed' | 'rejected';
  messageId: string;
  cost: number;
  currency: string;
  segments: number;
  httpStatus: number;
  apiResponseSummary: string;
  deduplicated: boolean;
}

interface WebhookDlrRecord {
  messageId: string;
  status: 'sent' | 'pending' | 'delivered' | 'failed' | 'rejected';
  cost?: number;
  parts?: number;
  rawSummary: string;
  updatedAt: number;
}

// Bounded in-memory idempotency cache (prevents duplicate sends on network retries)
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const idempotencyCache = new Map<string, CachedDispatch>();
const inFlightKeys = new Set<string>();

// Bounded in-memory webhook DLR store (populated by POST /api/sms/webhook)
const webhookDlrCache = new Map<string, WebhookDlrRecord>();

function pruneCaches(): void {
  const now = Date.now();
  if (idempotencyCache.size > 5000) {
    for (const [k, v] of idempotencyCache.entries()) {
      if (now - v.timestamp > IDEMPOTENCY_TTL_MS || idempotencyCache.size > 4000) {
        idempotencyCache.delete(k);
      }
    }
  }
  if (webhookDlrCache.size > 5000) {
    for (const [k, v] of webhookDlrCache.entries()) {
      if (now - v.updatedAt > IDEMPOTENCY_TTL_MS || webhookDlrCache.size > 4000) {
        webhookDlrCache.delete(k);
      }
    }
  }
}

function getSmsApiKey(): string {
  return (process.env.SMS_IO_API_KEY || '').trim();
}

function emailToStaffKey(email: string): string {
  return email
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .slice(0, 128);
}

// Verifies staff/admin authorization directly against Firestore REST using caller's own Firebase ID token
async function verifyPortalRbacFromFirestore(
  token: string,
  uid: string,
  email: string
): Promise<{ authorized: boolean; role: 'admin' | 'staff'; canSendBulk: boolean }> {
  const normalizedEmail = email.trim().toLowerCase();
  if (normalizedEmail === BOOTSTRAP_ADMIN_EMAIL) {
    return { authorized: true, role: 'admin', canSendBulk: true };
  }

  const base = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(FIREBASE_PROJECT_ID)}/databases/${encodeURIComponent(FIRESTORE_DATABASE_ID)}/documents`;

  // Check admins/{uid}
  try {
    const adminRes = await fetch(`${base}/admins/${encodeURIComponent(uid)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(6000),
    });
    if (adminRes.ok) {
      return { authorized: true, role: 'admin', canSendBulk: true };
    }
  } catch {
    // Fall through to staff_accounts check
  }

  // Check staff_accounts/{emailKey}
  try {
    const staffKey = emailToStaffKey(normalizedEmail);
    const staffRes = await fetch(`${base}/staff_accounts/${encodeURIComponent(staffKey)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(6000),
    });
    if (!staffRes.ok) {
      return { authorized: false, role: 'staff', canSendBulk: false };
    }
    const doc = (await staffRes.json()) as {
      fields?: Record<string, { stringValue?: string; booleanValue?: boolean }>;
    };
    const fields = doc.fields || {};
    const status = fields.status?.stringValue || '';
    const role = fields.role?.stringValue === 'admin' ? 'admin' : 'staff';
    const canSendBulk = role === 'admin' || fields.canSendBulk?.booleanValue === true;

    if (status === 'active') {
      return { authorized: true, role, canSendBulk };
    }
  } catch {
    // Denied on lookup failure
  }

  return { authorized: false, role: 'staff', canSendBulk: false };
}

function normalizeProviderStatus(rawStatus: unknown): 'pending' | 'sent' | 'delivered' | 'failed' | 'rejected' {
  const s = String(rawStatus || '').trim().toUpperCase();
  if (s === 'DELIVERED' || s === 'DELIVRD' || s === 'SUCCESS' || s === 'COMPLETED') return 'delivered';
  if (s === 'SENT' || s === 'SUBMITTED' || s === 'DISPATCHED') return 'sent';
  if (s === 'QUEUED' || s === 'PENDING' || s === 'ACCEPTED' || s === 'ONGOING' || s === 'SCHEDULED') return 'pending';
  if (s === 'REJECTED' || s === 'UNDELIV' || s === 'EXPIRED' || s === 'NO_FUNDS' || s === 'BLACKLISTED') return 'rejected';
  if (s === 'FAILED' || s === 'ERROR') return 'failed';
  return 'pending';
}

function calculateSegmentsServer(message: string): number {
  const gsm7Basic = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà]*$/;
  const isGsm = gsm7Basic.test(message);
  const len = message.length;
  if (len === 0) return 0;
  if (isGsm) {
    return len <= 160 ? 1 : Math.ceil(len / 153);
  }
  return len <= 70 ? 1 : Math.ceil(len / 67);
}

function safeSummarizeResponse(data: unknown, fallbackText: string): string {
  try {
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    return (str || fallbackText).slice(0, 950);
  } catch {
    return fallbackText.slice(0, 950);
  }
}

// Fetch wrapper with timeout & safe exponential backoff retries (ONLY on network errors, 429, or 5xx)
async function fetchWithTimeoutAndRetry(
  url: string,
  options: RequestInit,
  maxRetries = 2,
  timeoutMs = 15000
): Promise<{ ok: boolean; status: number; data: unknown; text: string }> {
  let attempt = 0;
  let lastError: unknown = null;

  while (attempt <= maxRetries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timer);

      const text = await response.text();
      let data: unknown = text;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text };
      }

      if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
        const delayMs = 600 * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delayMs));
        attempt += 1;
        continue;
      }

      return { ok: response.ok, status: response.status, data, text };
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (attempt < maxRetries) {
        const delayMs = 600 * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delayMs));
        attempt += 1;
        continue;
      }
    }
  }

  const message =
    lastError instanceof Error && lastError.name === 'AbortError'
      ? 'SMS.io API request timed out after 15 seconds'
      : lastError instanceof Error
        ? `Network error contacting SMS.io: ${lastError.message}`
        : 'Network error contacting SMS.io gateway';

  return {
    ok: false,
    status: 504,
    data: { error: message },
    text: message,
  };
}

// Firebase Auth + RBAC middleware for all protected /api/sms/* endpoints
async function requireFirebaseAuth(
  req: AuthenticatedRequest,
  res: express.Response,
  next: express.NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required. Missing Bearer token.' });
    return;
  }

  const token = authHeader.slice(7).trim();
  if (!token || !FIREBASE_PROJECT_ID) {
    res.status(401).json({ error: 'Authentication configuration invalid.' });
    return;
  }

  try {
    const { payload } = await jwtVerify(token, FIREBASE_JWKS, {
      issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
      audience: FIREBASE_PROJECT_ID,
    });

    const uid = typeof payload.sub === 'string' ? payload.sub : '';
    const email = typeof payload.email === 'string' ? payload.email : '';
    const emailVerified = payload.email_verified === true;

    if (!uid || !email || !emailVerified) {
      res.status(403).json({ error: 'Verified Google account email is required.' });
      return;
    }

    const rbac = await verifyPortalRbacFromFirestore(token, uid, email);
    if (!rbac.authorized) {
      res.status(403).json({
        error: 'Your account is not authorized to access ZACMA SMS PORTAL gateway services.',
      });
      return;
    }

    req.authUser = {
      uid,
      email,
      emailVerified,
      role: rbac.role,
      canSendBulk: rbac.canSendBulk,
    };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired authentication token. Please sign in again.' });
  }
}

async function startServer(): Promise<void> {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'zacma-sms-portal' });
  });

  app.get('/api/sms/config-status', requireFirebaseAuth, (_req, res) => {
    const configured = getSmsApiKey().length > 0;
    res.json({
      configured,
      senderId: DEFAULT_SENDER_ID,
      apiBaseUrl: SMS_API_BASE,
      authBaseUrl: SMS_AUTH_BASE,
      webhookPath: '/api/sms/webhook',
    });
  });

  app.get('/api/sms/balance', requireFirebaseAuth, async (_req, res) => {
    const apiKey = getSmsApiKey();
    if (!apiKey) {
      res.status(503).json({
        configured: false,
        error: 'SMS_IO_API_KEY is not configured in server environment variables.',
      });
      return;
    }

    const result = await fetchWithTimeoutAndRetry(
      `${SMS_AUTH_BASE}/api/balance`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
      },
      1,
      12000
    );

    if (!result.ok) {
      res.status(result.status >= 400 ? result.status : 502).json({
        configured: true,
        error: 'Failed to retrieve SMS.io account balance.',
        httpStatus: result.status,
        raw: result.data,
      });
      return;
    }

    const obj = (typeof result.data === 'object' && result.data !== null ? result.data : {}) as Record<string, unknown>;
    const balanceRaw = obj.balance ?? obj.credits ?? obj.amount ?? (obj.data as Record<string, unknown> | undefined)?.balance;
    const balance = typeof balanceRaw === 'number' ? balanceRaw : Number(balanceRaw);
    const currency = String(
      obj.currency ?? (obj.data as Record<string, unknown> | undefined)?.currency ?? 'USD'
    );

    res.json({
      configured: true,
      balance: Number.isFinite(balance) ? balance : null,
      currency,
      httpStatus: result.status,
      raw: result.data,
    });
  });

  app.post('/api/sms/estimate', requireFirebaseAuth, async (req, res) => {
    const apiKey = getSmsApiKey();
    const body = (req.body || {}) as {
      to?: string | string[];
      message?: string;
      senderId?: string;
    };

    const message = typeof body.message === 'string' ? body.message.trim() : '';
    const senderId = (typeof body.senderId === 'string' && body.senderId.trim()
      ? body.senderId.trim()
      : DEFAULT_SENDER_ID
    ).slice(0, 15);

    const rawTo = Array.isArray(body.to) ? body.to : typeof body.to === 'string' ? [body.to] : [];
    const recipients = rawTo.map((p) => String(p).trim()).filter((p) => E164_REGEX.test(p));

    if (!message || message.length > 1600) {
      res.status(400).json({ error: 'Message must be between 1 and 1600 characters.' });
      return;
    }
    if (recipients.length === 0) {
      res.status(400).json({ error: 'At least one valid E.164 phone number is required.' });
      return;
    }

    const localSegmentsPerMessage = calculateSegmentsServer(message);
    const localTotalSegments = localSegmentsPerMessage * recipients.length;

    if (!apiKey) {
      res.status(503).json({
        configured: false,
        estimatedSegments: localTotalSegments,
        segmentsPerMessage: localSegmentsPerMessage,
        estimatedCost: null,
        currency: 'USD',
        error: 'SMS_IO_API_KEY is not configured; live cost estimate unavailable.',
      });
      return;
    }

    const payload =
      recipients.length === 1
        ? { to: recipients[0], message, sender_id: senderId }
        : { to: recipients.slice(0, 50), message, sender_id: senderId };

    const result = await fetchWithTimeoutAndRetry(
      `${SMS_API_BASE}/sms/estimate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
      1,
      12000
    );

    if (!result.ok) {
      res.status(result.status >= 400 ? result.status : 502).json({
        configured: true,
        estimatedSegments: localTotalSegments,
        segmentsPerMessage: localSegmentsPerMessage,
        estimatedCost: null,
        currency: 'USD',
        httpStatus: result.status,
        error: 'SMS.io estimate request returned an error.',
        raw: result.data,
      });
      return;
    }

    const obj = (typeof result.data === 'object' && result.data !== null ? result.data : {}) as Record<string, unknown>;
    const rawCost =
      obj.estimated_cost ?? obj.cost ?? obj.price ?? (obj.data as Record<string, unknown> | undefined)?.estimated_cost;
    const sampleCost = typeof rawCost === 'number' ? rawCost : Number(rawCost);
    const scaleFactor = recipients.length > 50 ? recipients.length / 50 : 1;
    const estimatedCost = Number.isFinite(sampleCost) ? Number((sampleCost * scaleFactor).toFixed(4)) : null;

    res.json({
      configured: true,
      estimatedSegments: localTotalSegments,
      segmentsPerMessage: localSegmentsPerMessage,
      estimatedCost,
      currency: String(obj.currency || 'USD'),
      httpStatus: result.status,
      raw: result.data,
    });
  });

  app.post('/api/sms/send', requireFirebaseAuth, async (req: AuthenticatedRequest, res) => {
    if (!req.authUser?.canSendBulk) {
      res.status(403).json({
        success: false,
        status: 'rejected',
        httpStatus: 403,
        error: 'Your staff account does not have permission to send bulk SMS messages.',
      });
      return;
    }

    pruneCaches();

    const body = (req.body || {}) as {
      to?: string;
      message?: string;
      senderId?: string;
      idempotencyKey?: string;
    };

    const to = typeof body.to === 'string' ? body.to.trim() : '';
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    const senderId = (typeof body.senderId === 'string' && body.senderId.trim()
      ? body.senderId.trim()
      : DEFAULT_SENDER_ID
    ).slice(0, 15);
    const idempotencyKey =
      typeof body.idempotencyKey === 'string' && IDEMPOTENCY_REGEX.test(body.idempotencyKey.trim())
        ? body.idempotencyKey.trim()
        : '';

    if (!E164_REGEX.test(to)) {
      res.status(400).json({
        success: false,
        status: 'rejected',
        httpStatus: 400,
        error: `Invalid recipient phone number "${to}". Must be E.164 format (e.g. +251911223344).`,
      });
      return;
    }
    if (!message || message.length > 1600) {
      res.status(400).json({
        success: false,
        status: 'rejected',
        httpStatus: 400,
        error: 'Message content must be between 1 and 1600 characters.',
      });
      return;
    }
    if (!SENDER_ID_REGEX.test(senderId)) {
      res.status(400).json({
        success: false,
        status: 'rejected',
        httpStatus: 400,
        error: 'Invalid Sender ID format (max 15 alphanumeric characters).',
      });
      return;
    }
    if (!idempotencyKey) {
      res.status(400).json({
        success: false,
        status: 'rejected',
        httpStatus: 400,
        error: 'Missing valid idempotencyKey to prevent duplicate SMS delivery.',
      });
      return;
    }

    const existingDispatch = idempotencyCache.get(idempotencyKey);
    if (existingDispatch) {
      res.json({ ...existingDispatch.result, deduplicated: true });
      return;
    }

    if (inFlightKeys.has(idempotencyKey)) {
      res.status(409).json({
        success: false,
        status: 'pending',
        httpStatus: 409,
        error: 'A send request with this idempotencyKey is already in progress.',
      });
      return;
    }

    const apiKey = getSmsApiKey();
    const segments = calculateSegmentsServer(message);

    if (!apiKey) {
      res.status(503).json({
        success: false,
        status: 'failed',
        messageId: '',
        cost: 0,
        currency: 'USD',
        segments,
        httpStatus: 503,
        apiResponseSummary:
          'SMS_IO_API_KEY is not configured in server environment variables. Configure SMS_IO_API_KEY to send live SMS messages.',
        deduplicated: false,
      });
      return;
    }

    inFlightKeys.add(idempotencyKey);

    try {
      const appUrl = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
      const webhookSecret = (process.env.SMS_IO_WEBHOOK_SECRET || '').trim();
      const smsPayload: Record<string, unknown> = {
        message,
        to,
        sender_id: senderId,
      };
      if (appUrl && appUrl.startsWith('https://')) {
        smsPayload.callback_url = webhookSecret
          ? `${appUrl}/api/sms/webhook?secret=${encodeURIComponent(webhookSecret)}`
          : `${appUrl}/api/sms/webhook`;
      }

      const result = await fetchWithTimeoutAndRetry(
        `${SMS_API_BASE}/sms/send`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(smsPayload),
        },
        2,
        15000
      );

      const obj = (typeof result.data === 'object' && result.data !== null ? result.data : {}) as Record<string, unknown>;
      const providerSuccess = result.ok && obj.success !== false;
      const providerMessageId = String(
        obj.message_id ?? obj.trackingId ?? obj.id ?? (obj.data as Record<string, unknown> | undefined)?.message_id ?? ''
      ).slice(0, 128);
      const rawCost = obj.cost ?? obj.price ?? (obj.data as Record<string, unknown> | undefined)?.cost ?? 0;
      const cost = Number.isFinite(Number(rawCost)) ? Number(rawCost) : 0;
      const currency = String(obj.currency ?? 'USD').slice(0, 12);
      const mappedStatus = providerSuccess
        ? obj.status
          ? normalizeProviderStatus(obj.status)
          : 'sent'
        : result.status === 422 || result.status === 400
          ? 'rejected'
          : 'failed';

      const responsePayload: SendResultPayload = {
        success: providerSuccess,
        status: mappedStatus,
        messageId: providerMessageId,
        cost,
        currency,
        segments,
        httpStatus: result.status,
        apiResponseSummary: safeSummarizeResponse(result.data, result.text),
        deduplicated: false,
      };

      if (providerSuccess || providerMessageId) {
        idempotencyCache.set(idempotencyKey, {
          timestamp: Date.now(),
          result: responsePayload,
        });
      }

      res.status(providerSuccess ? 200 : result.status >= 400 ? result.status : 502).json(responsePayload);
    } finally {
      inFlightKeys.delete(idempotencyKey);
    }
  });

  app.post('/api/sms/status', requireFirebaseAuth, async (req, res) => {
    const body = (req.body || {}) as { messageIds?: string[] };
    const messageIds = Array.isArray(body.messageIds)
      ? body.messageIds
          .map((id) => String(id).trim())
          .filter((id) => id.length > 0 && id.length <= 128 && /^[a-zA-Z0-9_\-:.]+$/.test(id))
          .slice(0, 25)
      : [];

    if (messageIds.length === 0) {
      res.status(400).json({ error: 'Provide between 1 and 25 valid provider message IDs.' });
      return;
    }

    const apiKey = getSmsApiKey();
    if (!apiKey) {
      res.status(503).json({
        configured: false,
        error: 'SMS_IO_API_KEY is not configured in server environment variables.',
      });
      return;
    }

    const updates: Record<
      string,
      {
        status: 'pending' | 'sent' | 'delivered' | 'failed' | 'rejected';
        cost?: number;
        segments?: number;
        httpStatus: number;
        apiResponseSummary: string;
      }
    > = {};

    for (const msgId of messageIds) {
      const cachedDlr = webhookDlrCache.get(msgId);
      if (cachedDlr) {
        updates[msgId] = {
          status: cachedDlr.status,
          cost: cachedDlr.cost,
          segments: cachedDlr.parts,
          httpStatus: 200,
          apiResponseSummary: cachedDlr.rawSummary,
        };
        continue;
      }

      const singleRes = await fetchWithTimeoutAndRetry(
        `${SMS_API_BASE}/message/${encodeURIComponent(msgId)}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
          },
        },
        1,
        10000
      );

      if (singleRes.ok && typeof singleRes.data === 'object' && singleRes.data !== null) {
        const obj = singleRes.data as Record<string, unknown>;
        const nested = (obj.data as Record<string, unknown> | undefined) || obj;
        const costVal = Number(nested.cost ?? nested.price);
        const partsVal = Number(nested.parts ?? nested.segments);
        updates[msgId] = {
          status: normalizeProviderStatus(nested.status),
          cost: Number.isFinite(costVal) ? costVal : undefined,
          segments: Number.isFinite(partsVal) && partsVal >= 1 ? partsVal : undefined,
          httpStatus: singleRes.status,
          apiResponseSummary: safeSummarizeResponse(singleRes.data, singleRes.text),
        };
      } else {
        const listRes = await fetchWithTimeoutAndRetry(
          `${SMS_API_BASE}/v2/messages?limit=50`,
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              Accept: 'application/json',
            },
          },
          0,
          10000
        );
        if (listRes.ok && typeof listRes.data === 'object' && listRes.data !== null) {
          const listObj = listRes.data as Record<string, unknown>;
          const items = Array.isArray(listObj.data)
            ? listObj.data
            : Array.isArray(listObj.messages)
              ? listObj.messages
              : [];
          const found = items.find((item) => {
            if (typeof item !== 'object' || item === null) return false;
            const rec = item as Record<string, unknown>;
            return String(rec.id || rec.message_id || rec.trackingId || '') === msgId;
          }) as Record<string, unknown> | undefined;

          if (found) {
            const costVal = Number(found.cost ?? found.price);
            const partsVal = Number(found.parts ?? found.segments);
            updates[msgId] = {
              status: normalizeProviderStatus(found.status),
              cost: Number.isFinite(costVal) ? costVal : undefined,
              segments: Number.isFinite(partsVal) && partsVal >= 1 ? partsVal : undefined,
              httpStatus: listRes.status,
              apiResponseSummary: safeSummarizeResponse(found, ''),
            };
          }
        }
      }
    }

    res.json({ updates });
  });

  app.post('/api/sms/webhook', (req, res) => {
    const expectedSecret = (process.env.SMS_IO_WEBHOOK_SECRET || '').trim();
    if (expectedSecret) {
      const provided = String(req.headers['x-webhook-secret'] || req.query.secret || '');
      const a = Buffer.from(provided);
      const b = Buffer.from(expectedSecret);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        res.status(401).json({ error: 'Invalid webhook secret.' });
        return;
      }
    }

    const payload = (req.body || {}) as Record<string, unknown>;
    const msgId = String(payload.messageId || payload.message_id || payload.trackingId || payload.id || '').trim();
    if (!msgId || msgId.length > 128) {
      res.status(400).json({ error: 'Missing messageId in delivery report.' });
      return;
    }

    pruneCaches();
    const costNum = Number(payload.price ?? payload.cost);
    const partsNum = Number(payload.parts ?? payload.segments);

    webhookDlrCache.set(msgId, {
      messageId: msgId,
      status: normalizeProviderStatus(payload.status),
      cost: Number.isFinite(costNum) ? costNum : undefined,
      parts: Number.isFinite(partsNum) && partsNum >= 1 ? partsNum : undefined,
      rawSummary: safeSummarizeResponse(payload, 'Webhook DLR received'),
      updatedAt: Date.now(),
    });

    res.json({ received: true });
  });

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ZACMA SMS PORTAL server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
