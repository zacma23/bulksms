import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { WebSocketServer, WebSocket, type RawData } from 'ws';

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

// Official Google Firebase public JWKS for RS256 ID token verification
const FIREBASE_JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com')
);

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
  simSender?: string;
}

interface SimDlrRecord {
  messageId: string;
  status: 'sent' | 'pending' | 'delivered' | 'failed' | 'rejected';
  parts?: number;
  rawSummary: string;
  updatedAt: number;
}

// Bounded in-memory idempotency cache (prevents duplicate SMS sends on network retries)
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const idempotencyCache = new Map<string, CachedDispatch>();
const inFlightKeys = new Set<string>();

// Bounded in-memory delivery receipt cache (populated by Android companion sms:dlr WebSocket frames)
const simDlrCache = new Map<string, SimDlrRecord>();

type SimSlotPreference = 'auto' | 'sim1' | 'sim2';

interface PairingSessionRecord {
  pairingCode: string;
  shortPin: string;
  simSlot: SimSlotPreference;
  createdByUid: string;
  createdByEmail: string;
  createdAtMs: number;
  expiresAtMs: number;
  used: boolean;
}

interface LinkedDeviceRecord {
  id: string;
  deviceTokenHash: string;
  deviceName: string;
  androidVersion: string;
  phoneNumber: string;
  carrierName: string;
  simSlot: SimSlotPreference;
  dualSimSupported: boolean;
  clientType: 'android-native' | 'mobile-web';
  connectedAtMs: number;
  lastSeenAtMs: number;
  linkedByEmail: string;
}

const PAIRING_TTL_MS = 10 * 60 * 1000;
const SIM_DISPATCH_TIMEOUT_NATIVE_MS = 25 * 1000;
const SIM_DISPATCH_TIMEOUT_WEB_MS = 120 * 1000;
const WS_MOBILE_BRIDGE_PATH = '/ws/mobile-bridge';
const pairingSessions = new Map<string, PairingSessionRecord>();
const linkedDevices = new Map<string, LinkedDeviceRecord>();
const dashboardSockets = new Set<WebSocket>();
const deviceSockets = new Map<string, WebSocket>();

interface PendingSimJob {
  deviceId: string;
  resolve: (result: {
    success: boolean;
    status: 'sent' | 'delivered' | 'failed' | 'rejected';
    detail: string;
  }) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingSimJobs = new Map<string, PendingSimJob>();

function getOnlineLinkedDevice(preferredDeviceId?: string): {
  record: LinkedDeviceRecord;
  socket: WebSocket;
} | null {
  if (preferredDeviceId) {
    const rec = linkedDevices.get(preferredDeviceId);
    const sock = deviceSockets.get(preferredDeviceId);
    if (rec && sock && sock.readyState === WebSocket.OPEN) {
      return { record: rec, socket: sock };
    }
    return null;
  }
  for (const [devId, sock] of deviceSockets.entries()) {
    if (sock.readyState === WebSocket.OPEN) {
      const rec = linkedDevices.get(devId);
      if (rec) return { record: rec, socket: sock };
    }
  }
  return null;
}

function getOnlineDevicesCount(): number {
  let count = 0;
  for (const [devId, sock] of deviceSockets.entries()) {
    if (sock.readyState === WebSocket.OPEN && linkedDevices.has(devId)) {
      count += 1;
    }
  }
  return count;
}

function sanitizeSimSenderLabel(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9 +\-_.]/g, '').trim().slice(0, 15);
  return cleaned || 'ANDROID-SIM';
}

function dispatchViaAndroidSim(params: {
  device: { record: LinkedDeviceRecord; socket: WebSocket };
  to: string;
  message: string;
  simSlotOverride?: SimSlotPreference;
  idempotencyKey: string;
  segments: number;
}): Promise<SendResultPayload> {
  const { record, socket } = params.device;
  const effectiveSimSlot = params.simSlotOverride || record.simSlot;
  const jobId = `sim_${crypto.randomBytes(8).toString('hex')}`;
  const simSender = sanitizeSimSenderLabel(
    record.phoneNumber && record.phoneNumber !== 'SIM Primary'
      ? record.phoneNumber
      : effectiveSimSlot === 'sim1'
        ? 'SIM-1'
        : effectiveSimSlot === 'sim2'
          ? 'SIM-2'
          : 'ANDROID-SIM'
  );

  const dispatchTimeoutMs =
    record.clientType === 'mobile-web' ? SIM_DISPATCH_TIMEOUT_WEB_MS : SIM_DISPATCH_TIMEOUT_NATIVE_MS;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingSimJobs.delete(jobId);
      resolve({
        success: false,
        status: 'failed',
        messageId: jobId,
        cost: 0,
        currency: 'SIM',
        segments: params.segments,
        httpStatus: 504,
        apiResponseSummary: `Timed out waiting for phone "${record.deviceName}" (${effectiveSimSlot.toUpperCase()}) to confirm SIM SMS dispatch.`,
        deduplicated: false,
        simSender,
      });
    }, dispatchTimeoutMs);

    pendingSimJobs.set(jobId, {
      deviceId: record.id,
      timer,
      resolve: (outcome) => {
        resolve({
          success: outcome.success,
          status: outcome.status,
          messageId: jobId,
          cost: 0,
          currency: 'SIM',
          segments: params.segments,
          httpStatus: outcome.success ? 200 : 502,
          apiResponseSummary: outcome.detail.slice(0, 950),
          deduplicated: false,
          simSender,
        });
      },
    });

    try {
      socket.send(
        JSON.stringify({
          type: 'sms:dispatch',
          jobId,
          to: params.to,
          message: params.message,
          simSlot: effectiveSimSlot,
          idempotencyKey: params.idempotencyKey,
        })
      );
    } catch (err) {
      clearTimeout(timer);
      pendingSimJobs.delete(jobId);
      resolve({
        success: false,
        status: 'failed',
        messageId: jobId,
        cost: 0,
        currency: 'SIM',
        segments: params.segments,
        httpStatus: 502,
        apiResponseSummary:
          err instanceof Error
            ? `WebSocket write failed for "${record.deviceName}": ${err.message}`
            : 'WebSocket write failed for Android device.',
        deduplicated: false,
        simSender,
      });
    }
  });
}

function normalizeSimSlot(raw: unknown): SimSlotPreference {
  if (raw === 'sim1' || raw === 'sim2' || raw === 'auto') return raw;
  return 'auto';
}

function hashDeviceToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function verifyDeviceTokenHash(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashDeviceToken(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function prunePairingSessions(): void {
  const now = Date.now();
  for (const [code, session] of pairingSessions.entries()) {
    if (session.used || now > session.expiresAtMs) {
      pairingSessions.delete(code);
    }
  }
}

function serializeDevice(d: LinkedDeviceRecord) {
  const sock = deviceSockets.get(d.id);
  const online = Boolean(sock && sock.readyState === WebSocket.OPEN);
  return {
    id: d.id,
    deviceName: d.deviceName,
    androidVersion: d.androidVersion,
    phoneNumber: d.phoneNumber,
    carrierName: d.carrierName,
    simSlot: d.simSlot,
    dualSimSupported: d.dualSimSupported,
    clientType: d.clientType,
    online,
    connectedAt: new Date(d.connectedAtMs).toISOString(),
    lastSeenAt: new Date(d.lastSeenAtMs).toISOString(),
    linkedByEmail: d.linkedByEmail,
  };
}

function broadcastToDashboards(payload: Record<string, unknown>): void {
  const serialized = JSON.stringify(payload);
  for (const ws of dashboardSockets) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(serialized);
    } else {
      dashboardSockets.delete(ws);
    }
  }
}

function completeDevicePairing(body: {
  pairingCode?: unknown;
  deviceName?: unknown;
  androidVersion?: unknown;
  phoneNumber?: unknown;
  carrierName?: unknown;
  simSlot?: unknown;
  dualSimSupported?: unknown;
  clientType?: unknown;
}):
  | { ok: true; deviceToken: string; deviceRecord: LinkedDeviceRecord }
  | { ok: false; status: number; error: string } {
  prunePairingSessions();
  const rawCode = typeof body.pairingCode === 'string' ? body.pairingCode.trim() : '';
  if (!rawCode || rawCode.length > 128) {
    return { ok: false, status: 400, error: 'Valid pairingCode from QR scan is required.' };
  }

  const session = pairingSessions.get(rawCode);
  if (!session || session.used || Date.now() > session.expiresAtMs) {
    return {
      ok: false,
      status: 401,
      error: 'Pairing QR code has expired or was already used. Generate a new QR code.',
    };
  }

  session.used = true;
  pairingSessions.delete(rawCode);

  const deviceId = `dev_${crypto.randomBytes(8).toString('hex')}`;
  const deviceToken = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const clientType: 'android-native' | 'mobile-web' =
    body.clientType === 'mobile-web' ? 'mobile-web' : 'android-native';

  const deviceRecord: LinkedDeviceRecord = {
    id: deviceId,
    deviceTokenHash: hashDeviceToken(deviceToken),
    deviceName: (typeof body.deviceName === 'string' && body.deviceName.trim()
      ? body.deviceName.trim()
      : 'Android Phone'
    ).slice(0, 80),
    androidVersion: (typeof body.androidVersion === 'string' && body.androidVersion.trim()
      ? body.androidVersion.trim()
      : 'Android'
    ).slice(0, 32),
    phoneNumber: (typeof body.phoneNumber === 'string' && body.phoneNumber.trim()
      ? body.phoneNumber.trim()
      : 'SIM Primary'
    ).slice(0, 32),
    carrierName: (typeof body.carrierName === 'string' && body.carrierName.trim()
      ? body.carrierName.trim()
      : 'Mobile Carrier'
    ).slice(0, 60),
    simSlot: normalizeSimSlot(body.simSlot ?? session.simSlot),
    dualSimSupported: body.dualSimSupported === true,
    clientType,
    connectedAtMs: now,
    lastSeenAtMs: now,
    linkedByEmail: session.createdByEmail,
  };

  linkedDevices.set(deviceId, deviceRecord);
  return { ok: true, deviceToken, deviceRecord };
}

function pruneCaches(): void {
  const now = Date.now();
  if (idempotencyCache.size > 5000) {
    for (const [k, v] of idempotencyCache.entries()) {
      if (now - v.timestamp > IDEMPOTENCY_TTL_MS || idempotencyCache.size > 4000) {
        idempotencyCache.delete(k);
      }
    }
  }
  if (simDlrCache.size > 5000) {
    for (const [k, v] of simDlrCache.entries()) {
      if (now - v.updatedAt > IDEMPOTENCY_TTL_MS || simDlrCache.size > 4000) {
        simDlrCache.delete(k);
      }
    }
  }
  prunePairingSessions();
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

function normalizeSimStatus(rawStatus: unknown): 'pending' | 'sent' | 'delivered' | 'failed' | 'rejected' {
  const s = String(rawStatus || '').trim().toUpperCase();
  if (s === 'DELIVERED' || s === 'DELIVRD' || s === 'SUCCESS' || s === 'COMPLETED') return 'delivered';
  if (s === 'SENT' || s === 'SUBMITTED' || s === 'DISPATCHED') return 'sent';
  if (s === 'QUEUED' || s === 'PENDING' || s === 'ACCEPTED' || s === 'ONGOING' || s === 'SCHEDULED') return 'pending';
  if (s === 'REJECTED' || s === 'UNDELIV' || s === 'EXPIRED' || s === 'NO_FUNDS' || s === 'RADIO_OFF') return 'rejected';
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

// Shared Firebase ID token + Firestore RBAC verification for REST and WebSocket endpoints
async function verifyFirebaseTokenWithRbac(
  token: string
): Promise<{ ok: true; user: VerifiedUser } | { ok: false; status: number; error: string }> {
  if (!token || !FIREBASE_PROJECT_ID) {
    return { ok: false, status: 401, error: 'Authentication configuration invalid.' };
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
      return { ok: false, status: 403, error: 'Verified account email is required.' };
    }

    const rbac = await verifyPortalRbacFromFirestore(token, uid, email);
    if (!rbac.authorized) {
      return {
        ok: false,
        status: 403,
        error: 'Your account is not authorized to access ZACMA SMS PORTAL services.',
      };
    }

    return {
      ok: true,
      user: {
        uid,
        email,
        emailVerified,
        role: rbac.role,
        canSendBulk: rbac.canSendBulk,
      },
    };
  } catch {
    return {
      ok: false,
      status: 401,
      error: 'Invalid or expired authentication token. Please sign in again.',
    };
  }
}

// Firebase Auth + RBAC middleware for all protected /api/* endpoints
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
  const verification = await verifyFirebaseTokenWithRbac(token);
  if (!verification.ok) {
    res.status(verification.status).json({ error: verification.error });
    return;
  }

  req.authUser = verification.user;
  next();
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
    res.json({ ok: true, service: 'zacma-sms-portal', transport: 'android-sim-bridge' });
  });

  // Android SIM Bridge live status (replaces all third-party SMS gateway configuration)
  app.get('/api/sms/config-status', requireFirebaseAuth, (_req, res) => {
    const devices = Array.from(linkedDevices.values())
      .sort((a, b) => b.lastSeenAtMs - a.lastSeenAtMs)
      .map(serializeDevice);
    const onlineDevicesCount = getOnlineDevicesCount();
    res.json({
      simBridgeReady: onlineDevicesCount > 0,
      onlineDevicesCount,
      linkedDevicesCount: devices.length,
      devices,
      wsEndpoint: WS_MOBILE_BRIDGE_PATH,
    });
  });

  // Pure Android SIM dispatch via paired mobile phone WebSocket bridge
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
      deviceId?: string;
      simSlot?: unknown;
      idempotencyKey?: string;
    };

    const to = typeof body.to === 'string' ? body.to.trim() : '';
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    const senderId = (typeof body.senderId === 'string' && body.senderId.trim()
      ? body.senderId.trim()
      : 'ANDROID-SIM'
    ).slice(0, 15);
    const requestedDeviceId =
      typeof body.deviceId === 'string' && body.deviceId.trim() ? body.deviceId.trim() : undefined;
    const simSlotOverride =
      body.simSlot === 'auto' || body.simSlot === 'sim1' || body.simSlot === 'sim2'
        ? body.simSlot
        : undefined;
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
        error: 'Invalid SIM sender label format (max 15 characters).',
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

    const segments = calculateSegmentsServer(message);
    const onlineSimDevice = getOnlineLinkedDevice(requestedDeviceId);

    if (!onlineSimDevice) {
      res.status(503).json({
        success: false,
        status: 'failed',
        messageId: '',
        cost: 0,
        currency: 'SIM',
        segments,
        httpStatus: 503,
        apiResponseSummary: requestedDeviceId
          ? 'The selected Android phone is currently offline. Reconnect the companion app or choose another linked SIM device.'
          : 'No Android phone is connected over the SIM WebSocket bridge. Open Dashboard -> Connect Mobile Device and scan the QR code to link your phone SIM.',
        deduplicated: false,
      });
      return;
    }

    inFlightKeys.add(idempotencyKey);
    try {
      const simResult = await dispatchViaAndroidSim({
        device: onlineSimDevice,
        to,
        message,
        simSlotOverride,
        idempotencyKey,
        segments,
      });
      if (simResult.success) {
        idempotencyCache.set(idempotencyKey, {
          timestamp: Date.now(),
          result: simResult,
        });
      }
      res.status(simResult.success ? 200 : simResult.httpStatus).json(simResult);
    } finally {
      inFlightKeys.delete(idempotencyKey);
    }
  });

  // Sync delivery receipts reported by linked Android handsets (sms:dlr WebSocket frames)
  app.post('/api/sms/status', requireFirebaseAuth, (req, res) => {
    const body = (req.body || {}) as { messageIds?: string[] };
    const messageIds = Array.isArray(body.messageIds)
      ? body.messageIds
          .map((id) => String(id).trim())
          .filter((id) => id.length > 0 && id.length <= 128 && /^[a-zA-Z0-9_\-:.]+$/.test(id))
          .slice(0, 25)
      : [];

    if (messageIds.length === 0) {
      res.status(400).json({ error: 'Provide between 1 and 25 valid SIM dispatch IDs.' });
      return;
    }

    const updates: Record<
      string,
      {
        status: 'pending' | 'sent' | 'delivered' | 'failed' | 'rejected';
        segments?: number;
        httpStatus: number;
        apiResponseSummary: string;
      }
    > = {};

    for (const msgId of messageIds) {
      const cachedDlr = simDlrCache.get(msgId);
      if (cachedDlr) {
        updates[msgId] = {
          status: cachedDlr.status,
          segments: cachedDlr.parts,
          httpStatus: 200,
          apiResponseSummary: cachedDlr.rawSummary,
        };
      }
    }

    res.json({ updates });
  });

  // Mobile Android SIM Bridge pairing & device management routes
  app.get('/api/mobile-device/status', requireFirebaseAuth, (req: AuthenticatedRequest, res) => {
    prunePairingSessions();
    const uid = req.authUser?.uid || '';
    const forwardedProto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    const serverUrl = host ? `${forwardedProto}://${host}` : '';

    let latestSession: PairingSessionRecord | null = null;
    for (const session of pairingSessions.values()) {
      if (session.createdByUid === uid && !session.used && Date.now() < session.expiresAtMs) {
        if (!latestSession || session.createdAtMs > latestSession.createdAtMs) {
          latestSession = session;
        }
      }
    }

    const devices = Array.from(linkedDevices.values())
      .sort((a, b) => b.lastSeenAtMs - a.lastSeenAtMs)
      .map(serializeDevice);

    res.json({
      devices,
      activeSession: latestSession
        ? {
            pairingCode: latestSession.pairingCode,
            shortPin: latestSession.shortPin,
            simSlot: latestSession.simSlot,
            serverUrl,
            pairEndpoint: '/api/mobile-device/pair',
            wsEndpoint: WS_MOBILE_BRIDGE_PATH,
            createdAt: new Date(latestSession.createdAtMs).toISOString(),
            expiresAt: new Date(latestSession.expiresAtMs).toISOString(),
          }
        : null,
    });
  });

  app.post('/api/mobile-device/pairing-session', requireFirebaseAuth, (req: AuthenticatedRequest, res) => {
    prunePairingSessions();
    const uid = req.authUser?.uid || '';
    const email = req.authUser?.email || '';
    const body = (req.body || {}) as { simSlot?: unknown };
    const simSlot = normalizeSimSlot(body.simSlot);

    // Revoke previous unused pairing sessions created by this user
    for (const [code, existing] of pairingSessions.entries()) {
      if (existing.createdByUid === uid) {
        pairingSessions.delete(code);
      }
    }

    const pairingCode = crypto.randomBytes(24).toString('base64url');
    const pinDigits = crypto.randomInt(100000, 999999);
    const shortPin = `ZCM-${pinDigits}`;
    const now = Date.now();
    const expiresAtMs = now + PAIRING_TTL_MS;

    pairingSessions.set(pairingCode, {
      pairingCode,
      shortPin,
      simSlot,
      createdByUid: uid,
      createdByEmail: email,
      createdAtMs: now,
      expiresAtMs,
      used: false,
    });

    const forwardedProto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    const serverUrl = host ? `${forwardedProto}://${host}` : '';

    res.json({
      pairingCode,
      shortPin,
      simSlot,
      serverUrl,
      pairEndpoint: '/api/mobile-device/pair',
      wsEndpoint: WS_MOBILE_BRIDGE_PATH,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
  });

  // REST fallback handshake endpoint for Android companion app
  app.post('/api/mobile-device/pair', (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const paired = completeDevicePairing(body);
    if (!paired.ok) {
      res.status(paired.status).json({ error: paired.error });
      return;
    }

    const serialized = serializeDevice(paired.deviceRecord);
    broadcastToDashboards({ type: 'device:linked', device: serialized });

    res.json({
      paired: true,
      deviceToken: paired.deviceToken,
      wsEndpoint: WS_MOBILE_BRIDGE_PATH,
      device: serialized,
    });
  });

  app.patch('/api/mobile-device/:deviceId/sim', requireFirebaseAuth, (req, res) => {
    const deviceId = String(req.params.deviceId || '').trim();
    const record = linkedDevices.get(deviceId);
    if (!record) {
      res.status(404).json({ error: 'Linked mobile device not found.' });
      return;
    }
    const body = (req.body || {}) as { simSlot?: unknown };
    record.simSlot = normalizeSimSlot(body.simSlot);
    record.lastSeenAtMs = Date.now();
    const serialized = serializeDevice(record);

    const activeDeviceSock = deviceSockets.get(deviceId);
    if (activeDeviceSock && activeDeviceSock.readyState === WebSocket.OPEN) {
      activeDeviceSock.send(JSON.stringify({ type: 'sim:config', simSlot: record.simSlot }));
    }
    broadcastToDashboards({ type: 'device:updated', device: serialized });

    res.json({ device: serialized });
  });

  app.post('/api/mobile-device/:deviceId/test-sms', requireFirebaseAuth, async (req: AuthenticatedRequest, res) => {
    if (!req.authUser?.canSendBulk) {
      res.status(403).json({ error: 'Your account does not have permission to send SMS messages.' });
      return;
    }
    const deviceId = String(req.params.deviceId || '').trim();
    const onlineDevice = getOnlineLinkedDevice(deviceId);
    if (!onlineDevice) {
      res.status(409).json({
        error: 'Selected Android device is not currently online over the WebSocket bridge.',
      });
      return;
    }
    const body = (req.body || {}) as { to?: string; message?: string };
    const to = typeof body.to === 'string' ? body.to.trim() : '';
    const message = typeof body.message === 'string' ? body.message.trim() : '';

    if (!E164_REGEX.test(to)) {
      res.status(400).json({ error: 'Enter a valid E.164 phone number (e.g. +251911223344).' });
      return;
    }
    if (!message || message.length > 1600) {
      res.status(400).json({ error: 'Test message must be between 1 and 1600 characters.' });
      return;
    }

    const segments = calculateSegmentsServer(message);
    const idempotencyKey = `test_${deviceId}_${Date.now()}`;
    const result = await dispatchViaAndroidSim({
      device: onlineDevice,
      to,
      message,
      idempotencyKey,
      segments,
    });
    res.status(result.success ? 200 : result.httpStatus).json(result);
  });

  app.get('/api/mobile-device/companion-package', requireFirebaseAuth, (req, res) => {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    const wsProto = forwardedProto === 'https' ? 'wss' : 'ws';
    const wsUrl = host ? `${wsProto}://${host}${WS_MOBILE_BRIDGE_PATH}` : WS_MOBILE_BRIDGE_PATH;

    const manifestXml = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.zacma.simbridge">
  <uses-permission android:name="android.permission.SEND_SMS" />
  <uses-permission android:name="android.permission.READ_PHONE_STATE" />
  <uses-permission android:name="android.permission.INTERNET" />
  <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
  <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
  <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />

  <application android:label="ZACMA SIM Bridge" android:allowBackup="false">
    <activity android:name=".MainActivity" android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
    </activity>
  </application>
</manifest>`;

    const mainActivityKt = `package com.zacma.simbridge

import android.Manifest
import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.telephony.SmsManager
import android.telephony.SubscriptionManager
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import okhttp3.*
import org.json.JSONObject

class MainActivity : ComponentActivity() {
  private val client = OkHttpClient()
  private var ws: WebSocket? = null
  private val wsUrl = "${wsUrl}"

  // Automatically prompts user to grant SEND_SMS, READ_PHONE_STATE & POST_NOTIFICATIONS on startup
  private val permissionLauncher = registerForActivityResult(
    ActivityResultContracts.RequestMultiplePermissions()
  ) { results ->
    val smsGranted = results[Manifest.permission.SEND_SMS] == true
    if (smsGranted) {
      reconnectIfPaired()
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    requestRequiredPermissions()
  }

  private fun requestRequiredPermissions() {
    val perms = mutableListOf(
      Manifest.permission.SEND_SMS,
      Manifest.permission.READ_PHONE_STATE
    )
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      perms.add(Manifest.permission.POST_NOTIFICATIONS)
    }
    val missing = perms.filter {
      ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
    }
    if (missing.isNotEmpty()) {
      permissionLauncher.launch(missing.toTypedArray())
    } else {
      reconnectIfPaired()
    }
  }

  fun pairFromScannedQr(rawQrText: String) {
    // Supports both ZACMA HTTPS QR URLs (?pair=...) and raw JSON payloads
    val pairingCode = if (rawQrText.startsWith("http")) {
      Uri.parse(rawQrText).getQueryParameter("pair") ?: return
    } else {
      JSONObject(rawQrText).optString("pairingCode")
    }
    val simSlot = if (rawQrText.startsWith("http")) {
      Uri.parse(rawQrText).getQueryParameter("sim") ?: "auto"
    } else {
      JSONObject(rawQrText).optString("simSlot", "auto")
    }

    val request = Request.Builder().url(wsUrl).build()
    ws = client.newWebSocket(request, object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
        val frame = JSONObject().apply {
          put("type", "device:pair")
          put("pairingCode", pairingCode)
          put("deviceName", "\${Build.MANUFACTURER} \${Build.MODEL}")
          put("androidVersion", "Android \${Build.VERSION.RELEASE}")
          put("simSlot", simSlot)
          put("dualSimSupported", true)
          put("clientType", "android-native")
        }
        webSocket.send(frame.toString())
      }

      override fun onMessage(webSocket: WebSocket, text: String) {
        handleBridgeFrame(webSocket, JSONObject(text))
      }
    })
  }

  private fun reconnectIfPaired() {
    val prefs = getSharedPreferences("zacma_sim_bridge", Context.MODE_PRIVATE)
    val deviceId = prefs.getString("deviceId", null) ?: return
    val deviceToken = prefs.getString("deviceToken", null) ?: return
    val request = Request.Builder().url(wsUrl).build()
    ws = client.newWebSocket(request, object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
        webSocket.send(JSONObject(mapOf(
          "type" to "device:auth",
          "deviceId" to deviceId,
          "deviceToken" to deviceToken
        )).toString())
      }

      override fun onMessage(webSocket: WebSocket, text: String) {
        handleBridgeFrame(webSocket, JSONObject(text))
      }
    })
  }

  private fun handleBridgeFrame(webSocket: WebSocket, msg: JSONObject) {
    when (msg.optString("type")) {
      "device:paired" -> {
        val deviceObj = msg.getJSONObject("device")
        getSharedPreferences("zacma_sim_bridge", Context.MODE_PRIVATE).edit()
          .putString("deviceId", deviceObj.getString("id"))
          .putString("deviceToken", msg.getString("deviceToken"))
          .apply()
      }
      "sms:dispatch" -> {
        val jobId = msg.getString("jobId")
        val to = msg.getString("to")
        val body = msg.getString("message")
        val slot = msg.optString("simSlot", "auto")
        sendViaSim(webSocket, jobId, to, body, slot)
      }
    }
  }

  private fun sendViaSim(webSocket: WebSocket, jobId: String, to: String, body: String, slot: String) {
    try {
      val subManager = getSystemService(SubscriptionManager::class.java)
      val simIdx = when (slot) { "sim1" -> 0; "sim2" -> 1; else -> -1 }
      val subInfo = if (simIdx >= 0) subManager.activeSubscriptionInfoList?.getOrNull(simIdx) else null
      val smsManager = if (subInfo != null) {
        getSystemService(SmsManager::class.java).createForSubscriptionId(subInfo.subscriptionId)
      } else {
        getSystemService(SmsManager::class.java)
      }

      val sentAction = "ZACMA_SMS_SENT_\$jobId"
      val deliveredAction = "ZACMA_SMS_DELIVERED_\$jobId"

      registerReceiver(object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
          unregisterReceiver(this)
          val ok = resultCode == Activity.RESULT_OK
          webSocket.send(JSONObject(mapOf(
            "type" to "sms:result",
            "jobId" to jobId,
            "status" to if (ok) "sent" else "failed",
            "error" to if (ok) "" else "Android SmsManager resultCode=\$resultCode"
          )).toString())
        }
      }, IntentFilter(sentAction), RECEIVER_NOT_EXPORTED)

      registerReceiver(object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
          unregisterReceiver(this)
          if (resultCode == Activity.RESULT_OK) {
            webSocket.send(JSONObject(mapOf(
              "type" to "sms:dlr",
              "jobId" to jobId,
              "status" to "delivered"
            )).toString())
          }
        }
      }, IntentFilter(deliveredAction), RECEIVER_NOT_EXPORTED)

      val sentPi = PendingIntent.getBroadcast(this, jobId.hashCode(), Intent(sentAction), PendingIntent.FLAG_IMMUTABLE)
      val deliveredPi = PendingIntent.getBroadcast(this, jobId.hashCode() + 1, Intent(deliveredAction), PendingIntent.FLAG_IMMUTABLE)

      val parts = smsManager.divideMessage(body)
      val sentIntents = ArrayList<PendingIntent>().apply { repeat(parts.size) { add(sentPi) } }
      val deliveryIntents = ArrayList<PendingIntent>().apply { repeat(parts.size) { add(deliveredPi) } }
      smsManager.sendMultipartTextMessage(to, null, parts, sentIntents, deliveryIntents)
    } catch (e: Exception) {
      webSocket.send(JSONObject(mapOf(
        "type" to "sms:result",
        "jobId" to jobId,
        "status" to "failed",
        "error" to (e.message ?: "SIM send exception")
      )).toString())
    }
  }
}`;

    res.json({
      wsUrl,
      files: [
        { path: 'app/src/main/AndroidManifest.xml', content: manifestXml },
        { path: 'app/src/main/java/com/zacma/simbridge/MainActivity.kt', content: mainActivityKt },
      ],
    });
  });

  app.delete('/api/mobile-device/:deviceId', requireFirebaseAuth, (req, res) => {
    const deviceId = String(req.params.deviceId || '').trim();
    if (!linkedDevices.has(deviceId)) {
      res.status(404).json({ error: 'Linked mobile device not found.' });
      return;
    }
    linkedDevices.delete(deviceId);
    const activeDeviceSock = deviceSockets.get(deviceId);
    if (activeDeviceSock) {
      if (activeDeviceSock.readyState === WebSocket.OPEN) {
        activeDeviceSock.send(JSON.stringify({ type: 'device:unlinked', deviceId }));
      }
      activeDeviceSock.close(4003, 'Device unlinked by administrator');
      deviceSockets.delete(deviceId);
    }
    broadcastToDashboards({ type: 'device:unlinked', deviceId });
    res.json({ disconnected: true, deviceId });
  });

  const httpServer = http.createServer(app);

  // Secure WebSocket Pairing Bridge (/ws/mobile-bridge) attached to the same HTTP server on port 3000
  const mobileBridgeWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  httpServer.on('upgrade', (request, socket, head) => {
    try {
      const parsedUrl = new URL(request.url || '/', 'http://localhost');
      if (parsedUrl.pathname !== WS_MOBILE_BRIDGE_PATH) {
        return;
      }
      mobileBridgeWss.handleUpgrade(request, socket, head, (ws) => {
        mobileBridgeWss.emit('connection', ws, request);
      });
    } catch {
      socket.destroy();
    }
  });

  mobileBridgeWss.on('connection', (ws: WebSocket) => {
    let role: 'unauthenticated' | 'dashboard' | 'android' = 'unauthenticated';
    let boundDeviceId: string | null = null;

    const authTimeout = setTimeout(() => {
      if (role === 'unauthenticated' && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', error: 'Authentication handshake timed out.' }));
        ws.close(4001, 'Authentication timeout');
      }
    }, 10000);

    ws.on('message', async (rawData: RawData) => {
      let msg: Record<string, unknown>;
      try {
        const text = typeof rawData === 'string' ? rawData : rawData.toString('utf8');
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object') return;
        msg = parsed as Record<string, unknown>;
      } catch {
        ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON frame.' }));
        return;
      }

      const type = typeof msg.type === 'string' ? msg.type : '';

      // 1. Dashboard WebSocket authentication via Firebase ID token (not query params)
      if (type === 'auth:dashboard' && role === 'unauthenticated') {
        const idToken = typeof msg.idToken === 'string' ? msg.idToken.trim() : '';
        const verification = await verifyFirebaseTokenWithRbac(idToken);
        if (!verification.ok) {
          ws.send(JSON.stringify({ type: 'auth:error', error: verification.error }));
          ws.close(4001, 'Unauthorized');
          return;
        }
        clearTimeout(authTimeout);
        role = 'dashboard';
        dashboardSockets.add(ws);

        const devices = Array.from(linkedDevices.values())
          .sort((a, b) => b.lastSeenAtMs - a.lastSeenAtMs)
          .map(serializeDevice);
        ws.send(JSON.stringify({ type: 'bridge:init', devices }));
        return;
      }

      // 2. Android device first-time pairing via single-use QR pairingCode
      if (type === 'device:pair' && role === 'unauthenticated') {
        const paired = completeDevicePairing(msg);
        if (!paired.ok) {
          ws.send(JSON.stringify({ type: 'pair:error', error: paired.error }));
          ws.close(4002, 'Invalid pairing code');
          return;
        }
        clearTimeout(authTimeout);
        role = 'android';
        boundDeviceId = paired.deviceRecord.id;
        deviceSockets.set(boundDeviceId, ws);

        const serialized = serializeDevice(paired.deviceRecord);
        ws.send(
          JSON.stringify({
            type: 'device:paired',
            deviceId: serialized.id,
            deviceToken: paired.deviceToken,
            device: serialized,
          })
        );
        broadcastToDashboards({ type: 'device:linked', device: serialized });
        return;
      }

      // 3. Android device reconnection via previously issued deviceId + deviceToken
      if (type === 'device:auth' && role === 'unauthenticated') {
        const deviceId = typeof msg.deviceId === 'string' ? msg.deviceId.trim() : '';
        const deviceToken = typeof msg.deviceToken === 'string' ? msg.deviceToken.trim() : '';
        const record = linkedDevices.get(deviceId);
        if (!record || !deviceToken || !verifyDeviceTokenHash(deviceToken, record.deviceTokenHash)) {
          ws.send(JSON.stringify({ type: 'auth:error', error: 'Invalid or revoked device credentials.' }));
          ws.close(4001, 'Invalid device token');
          return;
        }
        clearTimeout(authTimeout);
        role = 'android';
        boundDeviceId = record.id;
        record.lastSeenAtMs = Date.now();

        const previousSock = deviceSockets.get(record.id);
        if (previousSock && previousSock !== ws && previousSock.readyState === WebSocket.OPEN) {
          previousSock.close(4000, 'Replaced by newer connection');
        }
        deviceSockets.set(record.id, ws);

        const serialized = serializeDevice(record);
        ws.send(JSON.stringify({ type: 'device:ready', device: serialized }));
        broadcastToDashboards({
          type: 'device:presence',
          deviceId: record.id,
          online: true,
          lastSeenAt: serialized.lastSeenAt,
        });
        return;
      }

      // 4. Android device SMS dispatch acknowledgment (sms:result)
      if (type === 'sms:result' && role === 'android' && boundDeviceId) {
        const jobId = typeof msg.jobId === 'string' ? msg.jobId.trim() : '';
        const pending = pendingSimJobs.get(jobId);
        if (pending && pending.deviceId === boundDeviceId) {
          clearTimeout(pending.timer);
          pendingSimJobs.delete(jobId);
          const rec = linkedDevices.get(boundDeviceId);
          if (rec) rec.lastSeenAtMs = Date.now();
          const normStatus = normalizeSimStatus(msg.status);
          const resolvedStatus: 'sent' | 'delivered' | 'failed' | 'rejected' =
            normStatus === 'pending' ? 'sent' : normStatus;
          const success = resolvedStatus === 'sent' || resolvedStatus === 'delivered';
          const detail =
            typeof msg.error === 'string' && msg.error.trim()
              ? msg.error.trim()
              : `Android SIM (${rec?.deviceName || 'Device'} · ${rec?.phoneNumber || rec?.simSlot || 'auto'}) reported ${resolvedStatus}`;
          pending.resolve({ success, status: resolvedStatus, detail });
        }
        return;
      }

      // 5. Android device asynchronous delivery receipt (sms:dlr)
      if (type === 'sms:dlr' && role === 'android' && boundDeviceId) {
        const jobId = typeof msg.jobId === 'string' ? msg.jobId.trim() : '';
        if (jobId && jobId.length <= 128) {
          pruneCaches();
          const rec = linkedDevices.get(boundDeviceId);
          if (rec) rec.lastSeenAtMs = Date.now();
          const normStatus = normalizeSimStatus(msg.status);
          simDlrCache.set(jobId, {
            messageId: jobId,
            status: normStatus,
            rawSummary: `Android SIM delivery receipt (${rec?.deviceName || 'Device'}): ${normStatus}`,
            updatedAt: Date.now(),
          });
          broadcastToDashboards({
            type: 'sms:dlr',
            jobId,
            deviceId: boundDeviceId,
            status: normStatus,
          });
        }
        return;
      }

      // 6. Authenticated heartbeat frames
      if (type === 'ping' && role !== 'unauthenticated') {
        if (role === 'android' && boundDeviceId) {
          const rec = linkedDevices.get(boundDeviceId);
          if (rec) rec.lastSeenAtMs = Date.now();
        }
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimeout);
      if (role === 'dashboard') {
        dashboardSockets.delete(ws);
      } else if (role === 'android' && boundDeviceId) {
        // Reject any in-flight SIM dispatch jobs assigned to this disconnected device
        for (const [jobId, pending] of pendingSimJobs.entries()) {
          if (pending.deviceId === boundDeviceId) {
            clearTimeout(pending.timer);
            pendingSimJobs.delete(jobId);
            pending.resolve({
              success: false,
              status: 'failed',
              detail: 'Android device disconnected before confirming SMS dispatch.',
            });
          }
        }
        if (deviceSockets.get(boundDeviceId) === ws) {
          deviceSockets.delete(boundDeviceId);
          const rec = linkedDevices.get(boundDeviceId);
          if (rec) {
            rec.lastSeenAtMs = Date.now();
            broadcastToDashboards({
              type: 'device:presence',
              deviceId: boundDeviceId,
              online: false,
              lastSeenAt: new Date(rec.lastSeenAtMs).toISOString(),
            });
          }
        }
      }
    });
  });

  if (!IS_PROD) {
    const disableHmr = process.env.DISABLE_HMR === 'true';
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ws: false,
        hmr: false,
        watch: disableHmr ? null : {},
      },
      appType: 'spa',
    });

    // In Vite 8 middlewareMode with ws/hmr disabled, Vite's built-in /@vite/client still
    // attempts to connect to ws://<host>:24678 and throws an unhandled rejection behind
    // single-port HTTPS proxies. Serve the exact style/HMR exports without opening port 24678.
    app.get('/@vite/client', (_req, res) => {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(`
const sheetsMap = new Map();
const linkSheetsMap = new Map();
if (typeof document !== "undefined") {
  document.querySelectorAll('link[rel="stylesheet"][data-vite-dev-id]').forEach((el) => {
    const id = el.getAttribute("data-vite-dev-id");
    if (id) linkSheetsMap.set(id, el);
  });
}
let lastInsertedStyle;
export function updateStyle(id, content) {
  if (typeof document === "undefined" || linkSheetsMap.has(id)) return;
  let style = sheetsMap.get(id);
  if (!style) {
    style = document.createElement("style");
    style.setAttribute("type", "text/css");
    style.setAttribute("data-vite-dev-id", id);
    style.textContent = content;
    if (!lastInsertedStyle) {
      document.head.appendChild(style);
      setTimeout(() => { lastInsertedStyle = undefined; }, 0);
    } else {
      lastInsertedStyle.insertAdjacentElement("afterend", style);
    }
    lastInsertedStyle = style;
  } else if (style.textContent !== content) {
    style.textContent = content;
  }
  sheetsMap.set(id, style);
}
export function removeStyle(id) {
  if (typeof document === "undefined") return;
  if (linkSheetsMap.has(id)) {
    document.querySelectorAll(\`link[rel="stylesheet"][data-vite-dev-id="\${CSS.escape(id)}"]\`).forEach((el) => el.remove());
    linkSheetsMap.delete(id);
  }
  const style = sheetsMap.get(id);
  if (style) {
    style.remove();
    sheetsMap.delete(id);
  }
}
export function createHotContext() {
  return {
    data: {},
    accept() {},
    acceptExports() {},
    dispose() {},
    prune() {},
    decline() {},
    invalidate() {},
    on() {},
    off() {},
    send() {},
  };
}
export function injectQuery(url, queryToInject) {
  if (url[0] !== "." && url[0] !== "/") return url;
  const pathname = url.replace(/[?#].*$/, "");
  const { search, hash } = new URL(url, "http://vite.dev");
  return \`\${pathname}?\${queryToInject}\${search ? "&" + search.slice(1) : ""}\${hash || ""}\`;
}
export class ErrorOverlay extends (typeof HTMLElement !== "undefined" ? HTMLElement : class {}) {
  close() {}
}
`);
    });

    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`ZACMA SMS PORTAL server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
