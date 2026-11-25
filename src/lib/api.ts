import { auth } from './firebase';
import type {
  LinkedMobileDevice,
  MobileDeviceStatusResponse,
  MobilePairingSession,
  SimBridgeStatus,
  SimSlotPreference,
  SmsDeliveryStatus,
} from '../types/portal';

const VALID_DELIVERY_STATUSES: ReadonlySet<SmsDeliveryStatus> = new Set([
  'pending',
  'sent',
  'delivered',
  'failed',
  'rejected',
]);

export function normalizeDeliveryStatus(
  raw: unknown,
  fallback: SmsDeliveryStatus = 'failed'
): SmsDeliveryStatus {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (VALID_DELIVERY_STATUSES.has(s as SmsDeliveryStatus)) {
    return s as SmsDeliveryStatus;
  }
  return fallback;
}

async function authFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('You must be signed in to access ZACMA SIM bridge services.');
  }
  const token = await user.getIdToken();
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init?.headers || {}),
    },
  });

  const rawText = await res.text();
  let data: Record<string, unknown> | null = null;
  if (rawText) {
    try {
      const parsed = JSON.parse(rawText);
      if (parsed && typeof parsed === 'object') {
        data = parsed as Record<string, unknown>;
      }
    } catch {
      data = null;
    }
  }

  if (!data) {
    throw new Error(
      `SIM bridge endpoint returned an invalid response (HTTP ${res.status}). Ensure the backend server is running.`
    );
  }

  if (!res.ok && !('httpStatus' in data)) {
    throw new Error(
      typeof data.error === 'string' && data.error
        ? data.error
        : `SIM bridge request failed (HTTP ${res.status})`
    );
  }
  return data as T;
}

export function fetchSimBridgeStatus(): Promise<SimBridgeStatus> {
  return authFetch<SimBridgeStatus>('/api/sms/config-status');
}

export interface SendSmsResponse {
  success: boolean;
  status: SmsDeliveryStatus;
  messageId: string;
  cost: number;
  currency: string;
  segments: number;
  httpStatus: number;
  apiResponseSummary: string;
  deduplicated: boolean;
  simSender?: string;
  error?: string;
}

export async function dispatchSingleSms(params: {
  to: string;
  message: string;
  senderId: string;
  deviceId?: string;
  simSlot?: SimSlotPreference;
  idempotencyKey: string;
}): Promise<SendSmsResponse> {
  const raw = await authFetch<Partial<SendSmsResponse>>('/api/sms/send', {
    method: 'POST',
    body: JSON.stringify(params),
  });
  const success = raw.success === true;
  const fallbackStatus: SmsDeliveryStatus = success ? 'sent' : 'failed';
  const segNum = Number(raw.segments);
  const httpNum = Number(raw.httpStatus);

  return {
    success,
    status: normalizeDeliveryStatus(raw.status, fallbackStatus),
    messageId: typeof raw.messageId === 'string' ? raw.messageId : '',
    cost: 0,
    currency: 'SIM',
    segments: Number.isFinite(segNum) && segNum >= 1 ? Math.round(segNum) : 1,
    httpStatus: Number.isFinite(httpNum) && httpNum >= 0 ? Math.round(httpNum) : success ? 200 : 500,
    apiResponseSummary:
      typeof raw.apiResponseSummary === 'string' && raw.apiResponseSummary
        ? raw.apiResponseSummary
        : typeof raw.error === 'string' && raw.error
          ? raw.error
          : success
            ? 'Dispatched via Android SIM'
            : 'Android SIM dispatch failed',
    deduplicated: raw.deduplicated === true,
    ...(typeof raw.simSender === 'string' && raw.simSender ? { simSender: raw.simSender } : {}),
    ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
  };
}

export interface StatusUpdateEntry {
  status: SmsDeliveryStatus;
  segments?: number;
  httpStatus: number;
  apiResponseSummary: string;
}

export function fetchDeliveryStatuses(
  messageIds: string[]
): Promise<{ updates: Record<string, StatusUpdateEntry>; error?: string }> {
  return authFetch<{ updates: Record<string, StatusUpdateEntry>; error?: string }>(
    '/api/sms/status',
    {
      method: 'POST',
      body: JSON.stringify({ messageIds }),
    }
  );
}

export function fetchMobileDeviceStatus(): Promise<MobileDeviceStatusResponse> {
  return authFetch<MobileDeviceStatusResponse>('/api/mobile-device/status');
}

export function createMobilePairingSession(
  simSlot: SimSlotPreference
): Promise<MobilePairingSession> {
  return authFetch<MobilePairingSession>('/api/mobile-device/pairing-session', {
    method: 'POST',
    body: JSON.stringify({ simSlot }),
  });
}

export function updateLinkedDeviceSimSlot(
  deviceId: string,
  simSlot: SimSlotPreference
): Promise<{ device: LinkedMobileDevice }> {
  return authFetch<{ device: LinkedMobileDevice }>(
    `/api/mobile-device/${encodeURIComponent(deviceId)}/sim`,
    {
      method: 'PATCH',
      body: JSON.stringify({ simSlot }),
    }
  );
}

export function disconnectLinkedDevice(
  deviceId: string
): Promise<{ disconnected: boolean; deviceId: string }> {
  return authFetch<{ disconnected: boolean; deviceId: string }>(
    `/api/mobile-device/${encodeURIComponent(deviceId)}`,
    {
      method: 'DELETE',
    }
  );
}

export function sendMobileDeviceTestSms(
  deviceId: string,
  to: string,
  message: string
): Promise<SendSmsResponse> {
  return authFetch<SendSmsResponse>(
    `/api/mobile-device/${encodeURIComponent(deviceId)}/test-sms`,
    {
      method: 'POST',
      body: JSON.stringify({ to, message }),
    }
  );
}
