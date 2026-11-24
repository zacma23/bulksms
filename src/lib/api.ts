import { auth } from './firebase';
import type { GatewayBalance, GatewayConfigStatus, SmsDeliveryStatus } from '../types/portal';

async function authFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('You must be signed in to call SMS gateway services.');
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

  const data = await res.json().catch(() => ({}));
  if (!res.ok && !('httpStatus' in data)) {
    throw new Error(data.error || `Gateway request failed (HTTP ${res.status})`);
  }
  return data as T;
}

export function fetchGatewayConfigStatus(): Promise<GatewayConfigStatus> {
  return authFetch<GatewayConfigStatus>('/api/sms/config-status');
}

export function fetchGatewayBalance(): Promise<GatewayBalance> {
  return authFetch<GatewayBalance>('/api/sms/balance');
}

export interface EstimateResponse {
  configured: boolean;
  estimatedSegments: number;
  segmentsPerMessage: number;
  estimatedCost: number | null;
  currency: string;
  httpStatus?: number;
  error?: string;
}

export function estimateSmsCost(params: {
  to: string[];
  message: string;
  senderId?: string;
}): Promise<EstimateResponse> {
  return authFetch<EstimateResponse>('/api/sms/estimate', {
    method: 'POST',
    body: JSON.stringify(params),
  });
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
  error?: string;
}

export function dispatchSingleSms(params: {
  to: string;
  message: string;
  senderId: string;
  idempotencyKey: string;
}): Promise<SendSmsResponse> {
  return authFetch<SendSmsResponse>('/api/sms/send', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export interface StatusUpdateEntry {
  status: SmsDeliveryStatus;
  cost?: number;
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
