import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Unsubscribe,
} from 'firebase/firestore';
import {
  auth,
  db,
  generateSafeId,
  handleFirestoreError,
  OperationType,
  ORG_ID,
} from './firebase';
import { analyzeSmsMessage } from './smsUtils';
import type { SendSmsResponse, StatusUpdateEntry } from './api';
import type {
  LinkedMobileDevice,
  MobilePairingSession,
  SimSlotPreference,
  SmsDeliveryStatus,
} from '../types/portal';

const PAIRING_TTL_MS = 10 * 60 * 1000;
const HEARTBEAT_ONLINE_WINDOW_MS = 95 * 1000;
const SIM_DISPATCH_TIMEOUT_MS = 120 * 1000;

interface FirestorePairingSessionData {
  shortPin: string;
  simSlot: SimSlotPreference;
  status: 'active' | 'used' | 'revoked';
  expiresAtMs: number;
  orgId: string;
  createdBy: string;
  createdByEmail: string;
  createdAt?: { toMillis?: () => number };
  updatedAt?: { toMillis?: () => number };
}

interface FirestoreMobileDeviceData {
  deviceName: string;
  androidVersion: string;
  phoneNumber: string;
  carrierName: string;
  simSlot: SimSlotPreference;
  dualSimSupported: boolean;
  clientType: 'android-native' | 'mobile-web';
  online: boolean;
  lastHeartbeatMs: number;
  orgId: string;
  linkedByUid: string;
  linkedByEmail: string;
  createdAt?: { toMillis?: () => number };
  updatedAt?: { toMillis?: () => number };
}

export interface FirestoreSmsJobItem {
  jobId: string;
  deviceId: string;
  to: string;
  message: string;
  simSlot: SimSlotPreference;
  status: 'queued' | 'sent' | 'delivered' | 'failed' | 'rejected';
  receivedAt: string;
}

function getOrigin(): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return '';
}

function generateSixDigitPin(): string {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    const num = 100000 + (arr[0] % 900000);
    return `ZCM-${num}`;
  }
  return `ZCM-${Math.floor(100000 + Math.random() * 900000)}`;
}

function toLinkedMobileDevice(
  id: string,
  data: FirestoreMobileDeviceData,
  nowMs = Date.now()
): LinkedMobileDevice {
  const lastHb = Number(data.lastHeartbeatMs) || 0;
  const isLive = data.online === true && nowMs - lastHb < HEARTBEAT_ONLINE_WINDOW_MS;
  const createdMs =
    data.createdAt && typeof data.createdAt.toMillis === 'function'
      ? data.createdAt.toMillis()
      : lastHb || nowMs;

  return {
    id,
    deviceName: data.deviceName || 'Android Phone SIM',
    androidVersion: data.androidVersion || 'Android',
    phoneNumber: data.phoneNumber || 'Android SIM',
    carrierName: data.carrierName || 'Mobile Carrier',
    simSlot:
      data.simSlot === 'sim1' || data.simSlot === 'sim2' || data.simSlot === 'auto'
        ? data.simSlot
        : 'auto',
    dualSimSupported: data.dualSimSupported !== false,
    clientType: data.clientType === 'android-native' ? 'android-native' : 'mobile-web',
    online: isLive,
    connectedAt: new Date(createdMs).toISOString(),
    lastSeenAt: new Date(lastHb || createdMs).toISOString(),
    linkedByEmail: data.linkedByEmail || '',
  };
}

function sanitizeSimSenderLabel(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9 +\-_.]/g, '').trim().slice(0, 15);
  return cleaned || 'ANDROID-SIM';
}

export async function createFirestorePairingSession(
  simSlot: SimSlotPreference
): Promise<MobilePairingSession> {
  const user = auth.currentUser;
  if (!user || !user.email) {
    throw new Error('Sign in with your authorized ZACMA Google account to generate a pairing QR code.');
  }

  const sessionId = generateSafeId('pair');
  const shortPin = generateSixDigitPin();
  const now = Date.now();
  const expiresAtMs = now + PAIRING_TTL_MS;

  try {
    await setDoc(doc(db, 'mobile_pairing_sessions', sessionId), {
      shortPin,
      simSlot,
      status: 'active',
      expiresAtMs,
      orgId: ORG_ID,
      createdBy: user.uid,
      createdByEmail: user.email,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `mobile_pairing_sessions/${sessionId}`);
  }

  return {
    pairingCode: sessionId,
    shortPin,
    simSlot,
    serverUrl: getOrigin(),
    pairEndpoint: '/api/mobile-device/pair',
    wsEndpoint: '/ws/mobile-bridge',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

export async function fetchActiveFirestorePairingSession(): Promise<MobilePairingSession | null> {
  const user = auth.currentUser;
  if (!user) return null;

  try {
    const snap = await getDocs(
      query(collection(db, 'mobile_pairing_sessions'), where('orgId', '==', ORG_ID))
    );
    const now = Date.now();
    let best: { id: string; data: FirestorePairingSessionData } | null = null;

    for (const d of snap.docs) {
      const data = d.data() as FirestorePairingSessionData;
      if (data.createdBy !== user.uid || data.status !== 'active' || data.expiresAtMs <= now) {
        continue;
      }
      if (!best || data.expiresAtMs > best.data.expiresAtMs) {
        best = { id: d.id, data };
      }
    }

    if (!best) return null;

    const createdMs =
      best.data.createdAt && typeof best.data.createdAt.toMillis === 'function'
        ? best.data.createdAt.toMillis()
        : best.data.expiresAtMs - PAIRING_TTL_MS;

    return {
      pairingCode: best.id,
      shortPin: best.data.shortPin,
      simSlot: best.data.simSlot,
      serverUrl: getOrigin(),
      pairEndpoint: '/api/mobile-device/pair',
      wsEndpoint: '/ws/mobile-bridge',
      createdAt: new Date(createdMs).toISOString(),
      expiresAt: new Date(best.data.expiresAtMs).toISOString(),
    };
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'mobile_pairing_sessions');
  }
}

export function subscribeFirestoreMobileDevices(
  onDevices: (devices: LinkedMobileDevice[]) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const q = query(collection(db, 'mobile_devices'), where('orgId', '==', ORG_ID));
  return onSnapshot(
    q,
    (snap) => {
      const now = Date.now();
      const list = snap.docs
        .map((d) => toLinkedMobileDevice(d.id, d.data() as FirestoreMobileDeviceData, now))
        .sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime());
      onDevices(list);
    },
    (err) => {
      if (onError) {
        onError(err);
      } else {
        handleFirestoreError(err, OperationType.LIST, 'mobile_devices');
      }
    }
  );
}

export async function listFirestoreMobileDevices(): Promise<LinkedMobileDevice[]> {
  const snap = await getDocs(
    query(collection(db, 'mobile_devices'), where('orgId', '==', ORG_ID))
  );
  const now = Date.now();
  return snap.docs
    .map((d) => toLinkedMobileDevice(d.id, d.data() as FirestoreMobileDeviceData, now))
    .sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime());
}

export async function completeFirestoreDevicePairing(params: {
  sessionId: string;
  deviceName: string;
  androidVersion: string;
  phoneNumber: string;
  carrierName: string;
  simSlot: SimSlotPreference;
}): Promise<{ deviceId: string; device: LinkedMobileDevice }> {
  const user = auth.currentUser;
  if (!user || !user.email) {
    throw new Error('Sign in with your authorized ZACMA Google account on this phone to complete pairing.');
  }

  const cleanSessionId = params.sessionId.trim();
  if (!/^[a-zA-Z0-9_\-]{4,128}$/.test(cleanSessionId)) {
    throw new Error('Invalid pairing code format. Scan a fresh QR code from the dashboard.');
  }

  const sessionRef = doc(db, 'mobile_pairing_sessions', cleanSessionId);
  const sessionSnap = await getDoc(sessionRef);
  if (!sessionSnap.exists()) {
    throw new Error('Pairing QR code was not found or expired. Generate a fresh QR on the dashboard.');
  }

  const sessionData = sessionSnap.data() as FirestorePairingSessionData;
  if (sessionData.status !== 'active' || Date.now() > Number(sessionData.expiresAtMs || 0)) {
    throw new Error('Pairing QR code has expired or was already used. Generate a new QR code.');
  }

  // Mark session as used (single-use security)
  await updateDoc(sessionRef, {
    status: 'used',
    updatedAt: serverTimestamp(),
  });

  const deviceId = generateSafeId('dev');
  const now = Date.now();
  const payload = {
    deviceName: (params.deviceName.trim() || 'Android Phone SIM').slice(0, 80),
    androidVersion: (params.androidVersion.trim() || 'Android').slice(0, 40),
    phoneNumber: (params.phoneNumber.trim() || 'Android SIM').slice(0, 32),
    carrierName: (params.carrierName.trim() || 'Ethio Telecom').slice(0, 60),
    simSlot: params.simSlot,
    dualSimSupported: true,
    clientType: 'mobile-web' as const,
    online: true,
    lastHeartbeatMs: now,
    orgId: ORG_ID,
    linkedByUid: user.uid,
    linkedByEmail: user.email,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  await setDoc(doc(db, 'mobile_devices', deviceId), payload);

  const device: LinkedMobileDevice = {
    id: deviceId,
    deviceName: payload.deviceName,
    androidVersion: payload.androidVersion,
    phoneNumber: payload.phoneNumber,
    carrierName: payload.carrierName,
    simSlot: payload.simSlot,
    dualSimSupported: true,
    clientType: 'mobile-web',
    online: true,
    connectedAt: new Date(now).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
    linkedByEmail: user.email,
  };

  return { deviceId, device };
}

export async function heartbeatFirestoreDevice(deviceId: string, online = true): Promise<void> {
  await updateDoc(doc(db, 'mobile_devices', deviceId), {
    online,
    lastHeartbeatMs: Date.now(),
    updatedAt: serverTimestamp(),
  });
}

export async function updateFirestoreDeviceSimSlot(
  deviceId: string,
  simSlot: SimSlotPreference
): Promise<LinkedMobileDevice> {
  const ref = doc(db, 'mobile_devices', deviceId);
  await updateDoc(ref, {
    simSlot,
    updatedAt: serverTimestamp(),
  });
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    throw new Error('Linked device no longer exists.');
  }
  return toLinkedMobileDevice(snap.id, snap.data() as FirestoreMobileDeviceData);
}

export async function unlinkFirestoreDevice(deviceId: string): Promise<void> {
  await deleteDoc(doc(db, 'mobile_devices', deviceId));
}

export function subscribeFirestoreDeviceDoc(
  deviceId: string,
  onChange: (device: LinkedMobileDevice | null) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  return onSnapshot(
    doc(db, 'mobile_devices', deviceId),
    (snap) => {
      if (!snap.exists()) {
        onChange(null);
        return;
      }
      onChange(toLinkedMobileDevice(snap.id, snap.data() as FirestoreMobileDeviceData));
    },
    (err) => {
      if (onError) onError(err);
    }
  );
}

export function subscribeDeviceQueuedSmsJobs(
  deviceId: string,
  onJobs: (jobs: FirestoreSmsJobItem[]) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const q = query(collection(db, 'mobile_sms_jobs'), where('orgId', '==', ORG_ID));
  return onSnapshot(
    q,
    (snap) => {
      const queued: FirestoreSmsJobItem[] = [];
      for (const d of snap.docs) {
        const data = d.data() as {
          deviceId?: string;
          recipientPhone?: string;
          messageContent?: string;
          simSlot?: SimSlotPreference;
          status?: 'queued' | 'sent' | 'delivered' | 'failed' | 'rejected';
          createdAt?: { toMillis?: () => number };
        };
        if (data.deviceId !== deviceId || data.status !== 'queued') continue;
        const tsMs =
          data.createdAt && typeof data.createdAt.toMillis === 'function'
            ? data.createdAt.toMillis()
            : Date.now();
        queued.push({
          jobId: d.id,
          deviceId: data.deviceId,
          to: data.recipientPhone || '',
          message: data.messageContent || '',
          simSlot:
            data.simSlot === 'sim1' || data.simSlot === 'sim2' || data.simSlot === 'auto'
              ? data.simSlot
              : 'auto',
          status: 'queued',
          receivedAt: new Date(tsMs).toISOString(),
        });
      }
      queued.sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
      onJobs(queued);
    },
    (err) => {
      if (onError) onError(err);
    }
  );
}

export async function completeFirestoreSmsJob(
  jobId: string,
  status: 'sent' | 'delivered' | 'failed' | 'rejected',
  resultSummary: string
): Promise<void> {
  await updateDoc(doc(db, 'mobile_sms_jobs', jobId), {
    status,
    resultSummary: resultSummary.slice(0, 500),
    updatedAt: serverTimestamp(),
  });
}

export async function dispatchSmsViaFirestoreBridge(params: {
  to: string;
  message: string;
  senderId?: string;
  deviceId?: string;
  simSlot?: SimSlotPreference;
  idempotencyKey: string;
}): Promise<SendSmsResponse> {
  const user = auth.currentUser;
  if (!user || !user.email) {
    throw new Error('Sign in with your authorized ZACMA account to send SMS.');
  }

  const segments = Math.max(1, Math.min(20, analyzeSmsMessage(params.message).segments || 1));
  const devices = await listFirestoreMobileDevices();
  const targetDevice = params.deviceId
    ? devices.find((d) => d.id === params.deviceId && d.online)
    : devices.find((d) => d.online);

  if (!targetDevice) {
    return {
      success: false,
      status: 'failed',
      messageId: '',
      cost: 0,
      currency: 'SIM',
      segments,
      httpStatus: 503,
      apiResponseSummary:
        'No linked Android phone is currently online. Open Connect Mobile Device and scan the QR code or tap Pair This Phone Directly first.',
      deduplicated: false,
    };
  }

  const effectiveSimSlot: SimSlotPreference = params.simSlot || targetDevice.simSlot || 'auto';
  const simSender = sanitizeSimSenderLabel(
    targetDevice.phoneNumber &&
      targetDevice.phoneNumber !== 'Android SIM' &&
      targetDevice.phoneNumber !== 'SIM Primary'
      ? targetDevice.phoneNumber
      : effectiveSimSlot === 'sim1'
        ? 'SIM-1'
        : effectiveSimSlot === 'sim2'
          ? 'SIM-2'
          : params.senderId || 'ANDROID-SIM'
  );

  const jobId = generateSafeId('job');
  const jobRef = doc(db, 'mobile_sms_jobs', jobId);
  const safeIdempotency =
    params.idempotencyKey.trim().length >= 8
      ? params.idempotencyKey.trim().slice(0, 128)
      : generateSafeId('idem');

  await setDoc(jobRef, {
    deviceId: targetDevice.id,
    recipientPhone: params.to,
    messageContent: params.message.slice(0, 1600),
    simSlot: effectiveSimSlot,
    idempotencyKey: safeIdempotency,
    status: 'queued',
    resultSummary: '',
    orgId: ORG_ID,
    createdBy: user.uid,
    createdByEmail: user.email,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  return new Promise<SendSmsResponse>((resolve) => {
    let settled = false;
    let unsub: Unsubscribe | null = null;

    const finish = (response: SendSmsResponse) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (unsub) unsub();
      resolve(response);
    };

    const timer = window.setTimeout(() => {
      finish({
        success: false,
        status: 'failed',
        messageId: jobId,
        cost: 0,
        currency: 'SIM',
        segments,
        httpStatus: 504,
        apiResponseSummary: `Timed out waiting for phone "${targetDevice.deviceName}" (${effectiveSimSlot.toUpperCase()}) to confirm SMS send.`,
        deduplicated: false,
        simSender,
      });
    }, SIM_DISPATCH_TIMEOUT_MS);

    unsub = onSnapshot(
      jobRef,
      (snap) => {
        if (!snap.exists()) return;
        const data = snap.data() as {
          status?: 'queued' | 'sent' | 'delivered' | 'failed' | 'rejected';
          resultSummary?: string;
        };
        if (!data.status || data.status === 'queued') return;
        const success = data.status === 'sent' || data.status === 'delivered';
        finish({
          success,
          status: data.status as SmsDeliveryStatus,
          messageId: jobId,
          cost: 0,
          currency: 'SIM',
          segments,
          httpStatus: success ? 200 : 502,
          apiResponseSummary:
            data.resultSummary ||
            `Phone "${targetDevice.deviceName}" (${simSender}) reported ${data.status}.`,
          deduplicated: false,
          simSender,
        });
      },
      (err) => {
        finish({
          success: false,
          status: 'failed',
          messageId: jobId,
          cost: 0,
          currency: 'SIM',
          segments,
          httpStatus: 500,
          apiResponseSummary: err.message || 'Lost connection while awaiting phone confirmation.',
          deduplicated: false,
          simSender,
        });
      }
    );
  });
}

export async function fetchFirestoreDeliveryStatuses(
  messageIds: string[]
): Promise<{ updates: Record<string, StatusUpdateEntry> }> {
  const updates: Record<string, StatusUpdateEntry> = {};
  const subset = messageIds.slice(0, 25);

  await Promise.all(
    subset.map(async (id) => {
      if (!/^[a-zA-Z0-9_\-]{1,128}$/.test(id)) return;
      try {
        const snap = await getDoc(doc(db, 'mobile_sms_jobs', id));
        if (!snap.exists()) return;
        const data = snap.data() as {
          status?: string;
          resultSummary?: string;
        };
        if (
          data.status === 'sent' ||
          data.status === 'delivered' ||
          data.status === 'failed' ||
          data.status === 'rejected'
        ) {
          updates[id] = {
            status: data.status,
            httpStatus: 200,
            apiResponseSummary:
              data.resultSummary || `Confirmed via linked phone SIM (${data.status})`,
          };
        }
      } catch {
        // Ignore non-Firestore IDs
      }
    })
  );

  return { updates };
}
