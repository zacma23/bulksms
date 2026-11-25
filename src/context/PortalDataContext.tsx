import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  db,
  generateSafeId,
  handleFirestoreError,
  OperationType,
  ORG_ID,
  recordAuditLog,
} from '../lib/firebase';
import {
  dispatchSingleSms,
  fetchDeliveryStatuses,
  fetchSimBridgeStatus,
  normalizeDeliveryStatus,
} from '../lib/api';
import {
  analyzeSmsMessage,
  buildIdempotencyKey,
  renderPersonalizedMessage,
} from '../lib/smsUtils';
import { useAuth } from './AuthContext';
import type {
  AuditLog,
  Campaign,
  Contact,
  ContactGroup,
  RecipientItem,
  SimBridgeStatus,
  SimSlotPreference,
  SmsTransaction,
  StaffAccount,
} from '../types/portal';

export interface ActiveDispatchProgress {
  campaignId: string;
  campaignName: string;
  total: number;
  processed: number;
  sent: number;
  failed: number;
  paused: boolean;
  cancelled: boolean;
  running: boolean;
  lastError: string | null;
}

interface PortalDataContextValue {
  groups: ContactGroup[];
  contacts: Contact[];
  campaigns: Campaign[];
  transactions: SmsTransaction[];
  staffAccounts: StaffAccount[];
  auditLogs: AuditLog[];
  dataLoading: boolean;
  simBridgeStatus: SimBridgeStatus | null;
  bridgeLoading: boolean;
  refreshSimBridgeStatus: () => Promise<void>;
  activeDispatch: ActiveDispatchProgress | null;
  pauseActiveDispatch: () => void;
  resumeActiveDispatch: () => void;
  cancelActiveDispatch: () => void;
  clearActiveDispatch: () => void;
  executeBulkCampaign: (params: {
    name: string;
    messageTemplate: string;
    senderId: string;
    deviceId?: string;
    simSlot?: SimSlotPreference;
    groupIds: string[];
    recipients: RecipientItem[];
    scheduledAt?: string;
  }) => Promise<string>;
  runScheduledCampaignNow: (campaign: Campaign) => Promise<void>;
  retryFailedForCampaign: (campaign: Campaign) => Promise<{ retried: number; succeeded: number }>;
  retrySingleTransaction: (tx: SmsTransaction) => Promise<boolean>;
  syncDeliveryReports: (txList?: SmsTransaction[]) => Promise<number>;
}

const PortalDataContext = createContext<PortalDataContextValue | null>(null);

function sortByCreatedDesc<T extends { createdAt?: { toMillis?: () => number } }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const ma = a.createdAt && typeof a.createdAt.toMillis === 'function' ? a.createdAt.toMillis() : 0;
    const mb = b.createdAt && typeof b.createdAt.toMillis === 'function' ? b.createdAt.toMillis() : 0;
    return mb - ma;
  });
}

export function PortalDataProvider({ children }: { children: React.ReactNode }) {
  const { firebaseUser, authorized, role } = useAuth();

  const [groups, setGroups] = useState<ContactGroup[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [transactions, setTransactions] = useState<SmsTransaction[]>([]);
  const [staffAccounts, setStaffAccounts] = useState<StaffAccount[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [dataLoading, setDataLoading] = useState(true);

  const [simBridgeStatus, setSimBridgeStatus] = useState<SimBridgeStatus | null>(null);
  const [bridgeLoading, setBridgeLoading] = useState(false);

  const [activeDispatch, setActiveDispatch] = useState<ActiveDispatchProgress | null>(null);
  const dispatchControlRef = useRef<{ paused: boolean; cancelled: boolean }>({
    paused: false,
    cancelled: false,
  });

  const refreshSimBridgeStatus = useCallback(async () => {
    if (!authorized || !firebaseUser) return;
    setBridgeLoading(true);
    try {
      const status = await fetchSimBridgeStatus();
      setSimBridgeStatus(status);
    } catch {
      setSimBridgeStatus({
        simBridgeReady: false,
        onlineDevicesCount: 0,
        linkedDevicesCount: 0,
        devices: [],
        wsEndpoint: '/ws/mobile-bridge',
      });
    } finally {
      setBridgeLoading(false);
    }
  }, [authorized, firebaseUser]);

  // Attach Firestore onSnapshot listeners ONLY when authenticated & authorized
  useEffect(() => {
    if (!authorized || !firebaseUser) {
      setGroups([]);
      setContacts([]);
      setCampaigns([]);
      setTransactions([]);
      setStaffAccounts([]);
      setAuditLogs([]);
      setDataLoading(false);
      return;
    }

    setDataLoading(true);
    let loadedCount = 0;
    const markLoaded = () => {
      loadedCount += 1;
      if (loadedCount >= 4) setDataLoading(false);
    };

    const unsubs: Array<() => void> = [];

    unsubs.push(
      onSnapshot(
        query(collection(db, 'contact_groups'), where('orgId', '==', ORG_ID)),
        (snap) => {
          const list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ContactGroup, 'id'>) }));
          setGroups(sortByCreatedDesc(list));
          markLoaded();
        },
        (error) => handleFirestoreError(error, OperationType.LIST, 'contact_groups')
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'contacts'), where('orgId', '==', ORG_ID)),
        (snap) => {
          const list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Contact, 'id'>) }));
          setContacts(sortByCreatedDesc(list));
          markLoaded();
        },
        (error) => handleFirestoreError(error, OperationType.LIST, 'contacts')
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'campaigns'), where('orgId', '==', ORG_ID)),
        (snap) => {
          const list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Campaign, 'id'>) }));
          setCampaigns(sortByCreatedDesc(list));
          markLoaded();
        },
        (error) => handleFirestoreError(error, OperationType.LIST, 'campaigns')
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'sms_transactions'), where('orgId', '==', ORG_ID)),
        (snap) => {
          const list = snap.docs.map((d) => ({
            id: d.id,
            ...(d.data() as Omit<SmsTransaction, 'id'>),
          }));
          setTransactions(sortByCreatedDesc(list));
          markLoaded();
        },
        (error) => handleFirestoreError(error, OperationType.LIST, 'sms_transactions')
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'audit_logs'), where('orgId', '==', ORG_ID)),
        (snap) => {
          const list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<AuditLog, 'id'>) }));
          setAuditLogs(sortByCreatedDesc(list));
        },
        (error) => handleFirestoreError(error, OperationType.LIST, 'audit_logs')
      )
    );

    if (role === 'admin') {
      unsubs.push(
        onSnapshot(
          query(collection(db, 'staff_accounts'), where('orgId', '==', ORG_ID)),
          (snap) => {
            const list = snap.docs.map((d) => ({
              id: d.id,
              ...(d.data() as Omit<StaffAccount, 'id'>),
            }));
            setStaffAccounts(sortByCreatedDesc(list));
          },
          (error) => handleFirestoreError(error, OperationType.LIST, 'staff_accounts')
        )
      );
    }

    void refreshSimBridgeStatus();

    return () => {
      unsubs.forEach((u) => u());
    };
  }, [authorized, firebaseUser, role, refreshSimBridgeStatus]);

  const pauseActiveDispatch = useCallback(() => {
    dispatchControlRef.current.paused = true;
    setActiveDispatch((prev) => (prev ? { ...prev, paused: true } : null));
  }, []);

  const resumeActiveDispatch = useCallback(() => {
    dispatchControlRef.current.paused = false;
    setActiveDispatch((prev) => (prev ? { ...prev, paused: false } : null));
  }, []);

  const cancelActiveDispatch = useCallback(() => {
    dispatchControlRef.current.cancelled = true;
    dispatchControlRef.current.paused = false;
    setActiveDispatch((prev) => (prev ? { ...prev, cancelled: true, paused: false } : null));
  }, []);

  const clearActiveDispatch = useCallback(() => {
    setActiveDispatch(null);
  }, []);

  // Core batch dispatcher with live progress, pause/cancel controls, and idempotency keys
  const runRecipientsLoop = useCallback(
    async (params: {
      campaignId: string;
      campaignName: string;
      messageTemplate: string;
      senderId: string;
      deviceId?: string;
      simSlot?: SimSlotPreference;
      recipients: RecipientItem[];
    }) => {
      if (!firebaseUser?.email) return;

      dispatchControlRef.current = { paused: false, cancelled: false };
      let sentCount = 0;
      let deliveredCount = 0;
      let failedCount = 0;

      setActiveDispatch({
        campaignId: params.campaignId,
        campaignName: params.campaignName,
        total: params.recipients.length,
        processed: 0,
        sent: 0,
        failed: 0,
        paused: false,
        cancelled: false,
        running: true,
        lastError: null,
      });

      try {
        await updateDoc(doc(db, 'campaigns', params.campaignId), {
          status: 'sending',
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `campaigns/${params.campaignId}`);
      }

      for (let i = 0; i < params.recipients.length; i++) {
        // Respect Pause state
        while (dispatchControlRef.current.paused && !dispatchControlRef.current.cancelled) {
          await new Promise((r) => setTimeout(r, 300));
        }

        if (dispatchControlRef.current.cancelled) {
          try {
            await updateDoc(doc(db, 'campaigns', params.campaignId), {
              status: 'cancelled',
              sentCount,
              deliveredCount,
              failedCount,
              pendingCount: Math.max(0, params.recipients.length - (sentCount + failedCount)),
              actualCost: 0,
              updatedAt: serverTimestamp(),
            });
          } catch (err) {
            handleFirestoreError(err, OperationType.UPDATE, `campaigns/${params.campaignId}`);
          }
          setActiveDispatch((prev) => (prev ? { ...prev, running: false, cancelled: true } : null));
          return;
        }

        const recipient = params.recipients[i];
        const personalized = renderPersonalizedMessage(params.messageTemplate, recipient).slice(0, 1600);
        const segInfo = analyzeSmsMessage(personalized);
        const idempotencyKey = buildIdempotencyKey(params.campaignId, recipient.phone, 0);
        const txId = generateSafeId('tx');

        let res;
        let lastError: string | null = null;
        try {
          res = await dispatchSingleSms({
            to: recipient.phone,
            message: personalized,
            senderId: params.senderId,
            deviceId: params.deviceId,
            simSlot: params.simSlot,
            idempotencyKey,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Android SIM dispatch failed';
          lastError = msg;
          res = {
            success: false,
            status: 'failed' as const,
            messageId: '',
            cost: 0,
            currency: 'SIM',
            segments: Math.max(1, segInfo.segments),
            httpStatus: 500,
            apiResponseSummary: msg.slice(0, 950),
            deduplicated: false,
          };
        }

        if (res.success) {
          sentCount += 1;
          if (res.status === 'delivered') deliveredCount += 1;
        } else {
          failedCount += 1;
          lastError = res.apiResponseSummary || res.error || 'Failed to send via SIM';
        }

        const safeStatus = normalizeDeliveryStatus(res.status, res.success ? 'sent' : 'failed');
        const safeSegments = Math.max(
          1,
          Math.min(20, Number.isFinite(Number(res.segments)) && Number(res.segments) >= 1 ? Math.round(Number(res.segments)) : segInfo.segments || 1)
        );
        const safeHttpStatus = Number.isFinite(Number(res.httpStatus)) && Number(res.httpStatus) >= 0
          ? Math.round(Number(res.httpStatus))
          : 0;
        const resolvedSender = (res.simSender || params.senderId || 'ANDROID-SIM').slice(0, 15);

        // Persist transaction record to Firestore
        try {
          await setDoc(doc(db, 'sms_transactions', txId), {
            campaignId: params.campaignId,
            campaignName: (params.campaignName || 'SMS Campaign').slice(0, 140),
            recipientName: (recipient.name || 'Customer').slice(0, 120),
            recipientPhone: recipient.phone,
            messageContent: personalized,
            senderId: resolvedSender,
            segments: safeSegments,
            cost: 0,
            currency: 'SIM',
            status: safeStatus,
            providerMessageId: (res.messageId || '').slice(0, 128),
            apiResponseSummary: (res.apiResponseSummary || lastError || '').slice(0, 1000),
            httpStatus: safeHttpStatus,
            idempotencyKey,
            retryCount: 0,
            orgId: ORG_ID,
            createdBy: firebaseUser.uid,
            createdByEmail: firebaseUser.email,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, `sms_transactions/${txId}`);
        }

        const processed = i + 1;
        setActiveDispatch((prev) =>
          prev
            ? {
                ...prev,
                processed,
                sent: sentCount,
                failed: failedCount,
                lastError: lastError ?? prev.lastError,
              }
            : null
        );
      }

      const finalStatus =
        sentCount === 0 && failedCount > 0 ? 'failed' : 'completed';

      try {
        await updateDoc(doc(db, 'campaigns', params.campaignId), {
          status: finalStatus,
          sentCount,
          deliveredCount,
          failedCount,
          pendingCount: 0,
          actualCost: 0,
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `campaigns/${params.campaignId}`);
      }

      void recordAuditLog({
        action: 'CAMPAIGN_EXECUTED',
        actorUid: firebaseUser.uid,
        actorEmail: firebaseUser.email,
        actorRole: role,
        targetType: 'campaign',
        targetId: params.campaignId,
        summary: `SIM campaign "${params.campaignName}" finished (${sentCount} sent, ${failedCount} failed of ${params.recipients.length})`,
      });

      setActiveDispatch((prev) => (prev ? { ...prev, running: false } : null));
      void refreshSimBridgeStatus();
    },
    [firebaseUser, role, refreshSimBridgeStatus]
  );

  const executeBulkCampaign = useCallback(
    async (params: {
      name: string;
      messageTemplate: string;
      senderId: string;
      deviceId?: string;
      simSlot?: SimSlotPreference;
      groupIds: string[];
      recipients: RecipientItem[];
      scheduledAt?: string;
    }): Promise<string> => {
      if (!firebaseUser?.email) throw new Error('Not signed in');

      const campaignId = generateSafeId('camp');
      const isScheduled = Boolean(params.scheduledAt && params.scheduledAt.trim().length > 0);
      const safeSender = (params.senderId.trim() || 'ANDROID-SIM').slice(0, 15);

      // Compute total estimated segments across personalized messages
      const totalSegments = params.recipients.reduce((acc, r) => {
        const rendered = renderPersonalizedMessage(params.messageTemplate, r);
        return acc + Math.max(1, analyzeSmsMessage(rendered).segments);
      }, 0);

      try {
        await setDoc(doc(db, 'campaigns', campaignId), {
          name: params.name.trim().slice(0, 140),
          messageTemplate: params.messageTemplate.trim().slice(0, 1600),
          senderId: safeSender,
          groupIds: params.groupIds.slice(0, 20),
          recipientCount: params.recipients.length,
          sentCount: 0,
          deliveredCount: 0,
          failedCount: 0,
          pendingCount: params.recipients.length,
          estimatedSegments: totalSegments,
          estimatedCost: 0,
          actualCost: 0,
          currency: 'SIM',
          status: isScheduled ? 'scheduled' : 'sending',
          scheduledAt: isScheduled ? (params.scheduledAt || '').slice(0, 40) : '',
          orgId: ORG_ID,
          createdBy: firebaseUser.uid,
          createdByEmail: firebaseUser.email,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, `campaigns/${campaignId}`);
      }

      void recordAuditLog({
        action: isScheduled ? 'CAMPAIGN_SCHEDULED' : 'CAMPAIGN_STARTED',
        actorUid: firebaseUser.uid,
        actorEmail: firebaseUser.email,
        actorRole: role,
        targetType: 'campaign',
        targetId: campaignId,
        summary: `${isScheduled ? 'Scheduled' : 'Started'} "${params.name}" via ${safeSender} for ${params.recipients.length} recipients (${totalSegments} segments)`,
      });

      if (!isScheduled) {
        await runRecipientsLoop({
          campaignId,
          campaignName: params.name.trim(),
          messageTemplate: params.messageTemplate.trim(),
          senderId: safeSender,
          deviceId: params.deviceId,
          simSlot: params.simSlot,
          recipients: params.recipients,
        });
      }

      return campaignId;
    },
    [firebaseUser, role, runRecipientsLoop]
  );

  const runScheduledCampaignNow = useCallback(
    async (campaign: Campaign) => {
      if (!firebaseUser?.email) return;
      // Resolve recipients from selected groups
      const targetContacts = contacts.filter((c) =>
        campaign.groupIds.some((gid) => c.groupIds.includes(gid))
      );
      const uniqueMap = new Map<string, RecipientItem>();
      for (const c of targetContacts) {
        if (!uniqueMap.has(c.phone)) {
          uniqueMap.set(c.phone, { phone: c.phone, name: c.name, source: 'group' });
        }
      }
      const recipients = Array.from(uniqueMap.values());
      if (recipients.length === 0) {
        throw new Error('No contacts found in the groups assigned to this scheduled campaign.');
      }

      await updateDoc(doc(db, 'campaigns', campaign.id), {
        recipientCount: recipients.length,
        pendingCount: recipients.length,
        updatedAt: serverTimestamp(),
      });

      await runRecipientsLoop({
        campaignId: campaign.id,
        campaignName: campaign.name,
        messageTemplate: campaign.messageTemplate,
        senderId: campaign.senderId || 'ANDROID-SIM',
        recipients,
      });
    },
    [contacts, firebaseUser, runRecipientsLoop]
  );

  const retrySingleTransaction = useCallback(
    async (tx: SmsTransaction): Promise<boolean> => {
      if (!firebaseUser?.email) return false;
      if (tx.status !== 'failed' && tx.status !== 'rejected') return false;

      const nextAttempt = (tx.retryCount || 0) + 1;
      const newKey = buildIdempotencyKey(tx.campaignId, tx.recipientPhone, nextAttempt);

      let res;
      try {
        res = await dispatchSingleSms({
          to: tx.recipientPhone,
          message: tx.messageContent,
          senderId: tx.senderId,
          idempotencyKey: newKey,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Android SIM retry failed';
        res = {
          success: false,
          status: 'failed' as const,
          messageId: '',
          cost: 0,
          currency: 'SIM',
          segments: Math.max(1, tx.segments || 1),
          httpStatus: 500,
          apiResponseSummary: msg.slice(0, 950),
          deduplicated: false,
        };
      }

      const safeRetryStatus = normalizeDeliveryStatus(res.status, res.success ? 'sent' : 'failed');
      const safeRetryHttp = Number.isFinite(Number(res.httpStatus)) ? Math.round(Number(res.httpStatus)) : 0;

      try {
        await updateDoc(doc(db, 'sms_transactions', tx.id), {
          status: safeRetryStatus,
          providerMessageId: (res.messageId || tx.providerMessageId || '').slice(0, 128),
          apiResponseSummary: (res.apiResponseSummary || '').slice(0, 1000),
          httpStatus: safeRetryHttp,
          cost: 0,
          segments: Math.max(1, Math.min(20, Number(res.segments) || tx.segments || 1)),
          retryCount: Math.min(10, nextAttempt),
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `sms_transactions/${tx.id}`);
      }

      // Recalculate parent campaign stats if succeeded
      if (res.success) {
        const parent = campaigns.find((c) => c.id === tx.campaignId);
        if (parent) {
          try {
            await updateDoc(doc(db, 'campaigns', parent.id), {
              sentCount: parent.sentCount + 1,
              failedCount: Math.max(0, parent.failedCount - 1),
              actualCost: 0,
              status: parent.failedCount <= 1 ? 'completed' : parent.status,
              updatedAt: serverTimestamp(),
            });
          } catch {
            // Campaign update best-effort
          }
        }
      }

      void recordAuditLog({
        action: 'SMS_RETRY',
        actorUid: firebaseUser.uid,
        actorEmail: firebaseUser.email,
        actorRole: role,
        targetType: 'sms_transaction',
        targetId: tx.id,
        summary: `Retried SMS to ${tx.recipientPhone} (attempt #${nextAttempt}): ${res.status}`,
      });

      return res.success;
    },
    [campaigns, firebaseUser, role]
  );

  const retryFailedForCampaign = useCallback(
    async (campaign: Campaign): Promise<{ retried: number; succeeded: number }> => {
      const failedTxs = transactions.filter(
        (t) => t.campaignId === campaign.id && (t.status === 'failed' || t.status === 'rejected')
      );
      let succeeded = 0;
      for (const tx of failedTxs) {
        const ok = await retrySingleTransaction(tx);
        if (ok) succeeded += 1;
      }
      return { retried: failedTxs.length, succeeded };
    },
    [transactions, retrySingleTransaction]
  );

  const syncDeliveryReports = useCallback(
    async (txList?: SmsTransaction[]): Promise<number> => {
      if (!firebaseUser?.email) return 0;
      const source = txList || transactions;
      const candidates = source
        .filter(
          (t) =>
            t.providerMessageId &&
            (t.status === 'pending' || t.status === 'sent')
        )
        .slice(0, 25);

      if (candidates.length === 0) return 0;

      const ids = candidates.map((t) => t.providerMessageId);
      const { updates } = await fetchDeliveryStatuses(ids);
      let updatedCount = 0;

      for (const tx of candidates) {
        const upd = updates[tx.providerMessageId];
        if (!upd) continue;
        const safeUpdStatus = normalizeDeliveryStatus(upd.status, tx.status);
        if (safeUpdStatus !== tx.status) {
          try {
            await updateDoc(doc(db, 'sms_transactions', tx.id), {
              status: safeUpdStatus,
              segments:
                upd.segments !== undefined && Number.isFinite(Number(upd.segments))
                  ? Math.min(20, Math.max(1, Math.round(Number(upd.segments))))
                  : tx.segments,
              httpStatus: Number.isFinite(Number(upd.httpStatus)) ? Math.round(Number(upd.httpStatus)) : tx.httpStatus,
              apiResponseSummary: (upd.apiResponseSummary || '').slice(0, 1000),
              updatedAt: serverTimestamp(),
            });
            updatedCount += 1;
          } catch (err) {
            handleFirestoreError(err, OperationType.UPDATE, `sms_transactions/${tx.id}`);
          }
        }
      }

      // Sync delivered counts on affected campaigns
      if (updatedCount > 0) {
        const affectedCampaignIds = new Set(candidates.map((c) => c.campaignId));
        for (const cid of affectedCampaignIds) {
          const campTxs = transactions.filter((t) => t.campaignId === cid);
          const delivered = campTxs.filter((t) => {
            const u = t.providerMessageId ? updates[t.providerMessageId] : undefined;
            return (u ? u.status : t.status) === 'delivered';
          }).length;
          try {
            await updateDoc(doc(db, 'campaigns', cid), {
              deliveredCount: delivered,
              updatedAt: serverTimestamp(),
            });
          } catch {
            // Non-fatal
          }
        }
      }

      return updatedCount;
    },
    [firebaseUser, transactions]
  );

  return (
    <PortalDataContext.Provider
      value={{
        groups,
        contacts,
        campaigns,
        transactions,
        staffAccounts,
        auditLogs,
        dataLoading,
        simBridgeStatus,
        bridgeLoading,
        refreshSimBridgeStatus,
        activeDispatch,
        pauseActiveDispatch,
        resumeActiveDispatch,
        cancelActiveDispatch,
        clearActiveDispatch,
        executeBulkCampaign,
        runScheduledCampaignNow,
        retryFailedForCampaign,
        retrySingleTransaction,
        syncDeliveryReports,
      }}
    >
      {children}
    </PortalDataContext.Provider>
  );
}

export function usePortalData(): PortalDataContextValue {
  const ctx = useContext(PortalDataContext);
  if (!ctx) throw new Error('usePortalData must be used inside PortalDataProvider');
  return ctx;
}
