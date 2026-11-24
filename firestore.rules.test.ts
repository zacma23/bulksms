/**
 * ZACMA SMS PORTAL — Firestore Security Rules Verification Spec
 * Documents the "Dirty Dozen" adversarial payloads verified against firestore.rules.
 */

export interface AdversarialTestCase {
  id: number;
  name: string;
  collection: string;
  docId: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  auth: { uid: string; email: string; email_verified: boolean } | null;
  payload?: Record<string, unknown>;
  expected: 'PERMISSION_DENIED';
}

export const DIRTY_DOZEN_CASES: AdversarialTestCase[] = [
  {
    id: 1,
    name: 'Unauthenticated read on contacts',
    collection: 'contacts',
    docId: 'contact_1',
    operation: 'get',
    auth: null,
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Unverified email spoof of bootstrap admin',
    collection: 'contacts',
    docId: 'contact_1',
    operation: 'get',
    auth: { uid: 'spoof_uid', email: 'zekimuluken@gmail.com', email_verified: false },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Self-admin escalation in admins collection',
    collection: 'admins',
    docId: 'staff_uid_1',
    operation: 'create',
    auth: { uid: 'staff_uid_1', email: 'staff@zacma.et', email_verified: true },
    payload: { uid: 'staff_uid_1', email: 'staff@zacma.et', grantedBy: 'staff_uid_1' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'Unauthorized staff account creation',
    collection: 'staff_accounts',
    docId: 'rogue_gmail_com',
    operation: 'create',
    auth: { uid: 'outsider_1', email: 'outsider@gmail.com', email_verified: true },
    payload: {
      email: 'rogue@gmail.com',
      fullName: 'Rogue User',
      role: 'admin',
      status: 'active',
      canSendBulk: true,
      canManageContacts: true,
      canManageCampaigns: true,
      canViewReports: true,
      orgId: 'zacma',
      createdBy: 'outsider_1',
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'Shadow ghost field injection on contact create',
    collection: 'contacts',
    docId: 'contact_shadow',
    operation: 'create',
    auth: { uid: 'admin_1', email: 'zekimuluken@gmail.com', email_verified: true },
    payload: {
      name: 'Abebe Bikila',
      phone: '+251911223344',
      groupIds: [],
      notes: '',
      orgId: 'zacma',
      createdBy: 'admin_1',
      isVerified: true, // Ghost field
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'Path variable ID poisoning (>128 chars or invalid chars)',
    collection: 'contacts',
    docId: 'bad$id!' + 'a'.repeat(140),
    operation: 'create',
    auth: { uid: 'admin_1', email: 'zekimuluken@gmail.com', email_verified: true },
    payload: {
      name: 'Test',
      phone: '+251911223344',
      groupIds: [],
      notes: '',
      orgId: 'zacma',
      createdBy: 'admin_1',
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'Identity spoofing on campaign creation',
    collection: 'campaigns',
    docId: 'camp_spoof',
    operation: 'create',
    auth: { uid: 'staff_uid_1', email: 'staff@zacma.et', email_verified: true },
    payload: {
      name: 'Spoof Campaign',
      messageTemplate: 'Hello',
      senderId: 'ZACMA',
      groupIds: [],
      recipientCount: 1,
      sentCount: 0,
      deliveredCount: 0,
      failedCount: 0,
      pendingCount: 1,
      estimatedSegments: 1,
      estimatedCost: 0,
      actualCost: 0,
      currency: 'USD',
      status: 'draft',
      scheduledAt: '',
      orgId: 'zacma',
      createdBy: 'another_uid', // Spoofed
      createdByEmail: 'zekimuluken@gmail.com',
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'Immutable createdBy tampering on contact update',
    collection: 'contacts',
    docId: 'contact_1',
    operation: 'update',
    auth: { uid: 'staff_uid_1', email: 'staff@zacma.et', email_verified: true },
    payload: { createdBy: 'hijacked_uid' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Value poisoning on campaign messageTemplate (>1600 chars)',
    collection: 'campaigns',
    docId: 'camp_1',
    operation: 'update',
    auth: { uid: 'admin_1', email: 'zekimuluken@gmail.com', email_verified: true },
    payload: { messageTemplate: 'x'.repeat(2000) },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'Terminal state mutation of completed campaign by staff',
    collection: 'campaigns',
    docId: 'camp_completed',
    operation: 'update',
    auth: { uid: 'staff_uid_1', email: 'staff@zacma.et', email_verified: true },
    payload: { status: 'sending' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Audit log deletion attempt even by admin',
    collection: 'audit_logs',
    docId: 'log_1',
    operation: 'delete',
    auth: { uid: 'admin_1', email: 'zekimuluken@gmail.com', email_verified: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'Array overflow (>20 groupIds) and invalid E.164 phone',
    collection: 'contacts',
    docId: 'contact_overflow',
    operation: 'create',
    auth: { uid: 'admin_1', email: 'zekimuluken@gmail.com', email_verified: true },
    payload: {
      name: 'Overflow Contact',
      phone: '0911223344', // Missing +251 E.164
      groupIds: Array.from({ length: 25 }, (_, i) => `g_${i}`),
      notes: '',
      orgId: 'zacma',
      createdBy: 'admin_1',
    },
    expected: 'PERMISSION_DENIED',
  },
];
