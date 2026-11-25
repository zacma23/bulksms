import { buildAndroidCompanionSource } from './androidCompanionGenerator';
import {
  createFirestorePairingSession,
  dispatchSmsViaFirestoreBridge,
  fetchActiveFirestorePairingSession,
  fetchFirestoreDeliveryStatuses,
  listFirestoreMobileDevices,
  unlinkFirestoreDevice,
  updateFirestoreDeviceSimSlot,
} from './firestoreSimBridge';
import { generateSafeId } from './firebase';
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

export interface StatusUpdateEntry {
  status: SmsDeliveryStatus;
  segments?: number;
  httpStatus: number;
  apiResponseSummary: string;
}

export async function fetchSimBridgeStatus(): Promise<SimBridgeStatus> {
  const devices = await listFirestoreMobileDevices();
  const onlineDevicesCount = devices.filter((d) => d.online).length;
  return {
    simBridgeReady: onlineDevicesCount > 0,
    onlineDevicesCount,
    linkedDevicesCount: devices.length,
    devices,
    wsEndpoint: '/ws/mobile-bridge',
  };
}

export async function dispatchSingleSms(params: {
  to: string;
  message: string;
  senderId: string;
  deviceId?: string;
  simSlot?: SimSlotPreference;
  idempotencyKey: string;
}): Promise<SendSmsResponse> {
  return dispatchSmsViaFirestoreBridge(params);
}

export async function fetchDeliveryStatuses(
  messageIds: string[]
): Promise<{ updates: Record<string, StatusUpdateEntry>; error?: string }> {
  return fetchFirestoreDeliveryStatuses(messageIds);
}

export async function fetchMobileDeviceStatus(): Promise<MobileDeviceStatusResponse> {
  const [devices, activeSession] = await Promise.all([
    listFirestoreMobileDevices(),
    fetchActiveFirestorePairingSession(),
  ]);
  return {
    devices,
    activeSession,
  };
}

export async function createMobilePairingSession(
  simSlot: SimSlotPreference
): Promise<MobilePairingSession> {
  return createFirestorePairingSession(simSlot);
}

export async function updateLinkedDeviceSimSlot(
  deviceId: string,
  simSlot: SimSlotPreference
): Promise<{ device: LinkedMobileDevice }> {
  const device = await updateFirestoreDeviceSimSlot(deviceId, simSlot);
  return { device };
}

export async function disconnectLinkedDevice(
  deviceId: string
): Promise<{ disconnected: boolean; deviceId: string }> {
  await unlinkFirestoreDevice(deviceId);
  return { disconnected: true, deviceId };
}

export async function sendMobileDeviceTestSms(
  deviceId: string,
  to: string,
  message: string
): Promise<SendSmsResponse> {
  return dispatchSmsViaFirestoreBridge({
    deviceId,
    to,
    message,
    idempotencyKey: generateSafeId('test'),
  });
}

export interface AndroidCompanionPackageResponse {
  wsUrl: string;
  files: Array<{ path: string; content: string }>;
}

export async function fetchAndroidCompanionPackage(): Promise<AndroidCompanionPackageResponse> {
  const origin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'https://zacma.app';
  return buildAndroidCompanionSource(origin);
}
