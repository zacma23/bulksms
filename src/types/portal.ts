import type { Timestamp } from 'firebase/firestore';

export type UserRole = 'admin' | 'staff';
export type AccountStatus = 'active' | 'suspended';

export interface StaffPermissions {
  canSendBulk: boolean;
  canManageContacts: boolean;
  canManageCampaigns: boolean;
  canViewReports: boolean;
}

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  role: UserRole;
  status: AccountStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface StaffAccount {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  status: AccountStatus;
  canSendBulk: boolean;
  canManageContacts: boolean;
  canManageCampaigns: boolean;
  canViewReports: boolean;
  orgId: 'zacma';
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ContactGroup {
  id: string;
  name: string;
  description: string;
  orgId: 'zacma';
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Contact {
  id: string;
  name: string;
  phone: string;
  groupIds: string[];
  notes: string;
  orgId: 'zacma';
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type CampaignStatus =
  | 'draft'
  | 'scheduled'
  | 'sending'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface Campaign {
  id: string;
  name: string;
  messageTemplate: string;
  senderId: string;
  groupIds: string[];
  recipientCount: number;
  sentCount: number;
  deliveredCount: number;
  failedCount: number;
  pendingCount: number;
  estimatedSegments: number;
  estimatedCost: number;
  actualCost: number;
  currency: string;
  status: CampaignStatus;
  scheduledAt: string;
  orgId: 'zacma';
  createdBy: string;
  createdByEmail: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type SmsDeliveryStatus = 'pending' | 'sent' | 'delivered' | 'failed' | 'rejected';

export interface SmsTransaction {
  id: string;
  campaignId: string;
  campaignName: string;
  recipientName: string;
  recipientPhone: string;
  messageContent: string;
  senderId: string;
  segments: number;
  cost: number;
  currency: string;
  status: SmsDeliveryStatus;
  providerMessageId: string;
  apiResponseSummary: string;
  httpStatus: number;
  idempotencyKey: string;
  retryCount: number;
  orgId: 'zacma';
  createdBy: string;
  createdByEmail: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface AuditLog {
  id: string;
  action: string;
  actorUid: string;
  actorEmail: string;
  actorRole: UserRole;
  targetType: string;
  targetId: string;
  summary: string;
  orgId: 'zacma';
  createdAt: Timestamp;
}

export interface SimBridgeStatus {
  simBridgeReady: boolean;
  onlineDevicesCount: number;
  linkedDevicesCount: number;
  devices: LinkedMobileDevice[];
  wsEndpoint: string;
}

export interface RecipientItem {
  phone: string;
  name: string;
  source: 'manual' | 'group' | 'file';
}

export type PortalTab =
  | 'dashboard'
  | 'send'
  | 'contacts'
  | 'campaigns'
  | 'history'
  | 'staff'
  | 'audit';

export type SimSlotPreference = 'auto' | 'sim1' | 'sim2';

export interface MobilePairingSession {
  pairingCode: string;
  shortPin: string;
  simSlot: SimSlotPreference;
  serverUrl: string;
  pairEndpoint: string;
  wsEndpoint: string;
  createdAt: string;
  expiresAt: string;
}

export interface LinkedMobileDevice {
  id: string;
  deviceName: string;
  androidVersion: string;
  phoneNumber: string;
  carrierName: string;
  simSlot: SimSlotPreference;
  dualSimSupported: boolean;
  online: boolean;
  connectedAt: string;
  lastSeenAt: string;
  linkedByEmail: string;
}

export interface MobileDeviceStatusResponse {
  devices: LinkedMobileDevice[];
  activeSession: MobilePairingSession | null;
}
