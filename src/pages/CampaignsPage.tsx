import { useMemo, useState } from 'react';
import {
  Play,
  Pause,
  XCircle,
  RotateCcw,
  RefreshCw,
  Eye,
  Plus,
  X,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { usePortalData } from '../context/PortalDataContext';
import { db, handleFirestoreError, OperationType, recordAuditLog } from '../lib/firebase';
import { formatTimestamp } from '../lib/smsUtils';
import type { Campaign, CampaignStatus, PortalTab } from '../types/portal';

const STATUS_FILTERS: Array<{ id: 'all' | CampaignStatus; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'scheduled', label: 'Scheduled' },
  { id: 'sending', label: 'Sending' },
  { id: 'paused', label: 'Paused' },
  { id: 'completed', label: 'Completed' },
  { id: 'failed', label: 'Failed' },
  { id: 'cancelled', label: 'Cancelled' },
];

export function CampaignsPage({ onNavigate }: { onNavigate: (tab: PortalTab) => void }) {
  const { firebaseUser, role, permissions } = useAuth();
  const {
    campaigns,
    groups,
    transactions,
    runScheduledCampaignNow,
    retryFailedForCampaign,
    syncDeliveryReports,
  } = usePortalData();

  const [statusFilter, setStatusFilter] = useState<'all' | CampaignStatus>('all');
  const [selectedCampaign, setSelectedCampaign] = useState<Campaign | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const groupMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of groups) m.set(g.id, g.name);
    return m;
  }, [groups]);

  const filteredCampaigns = useMemo(() => {
    if (statusFilter === 'all') return campaigns;
    return campaigns.filter((c) => c.status === statusFilter);
  }, [campaigns, statusFilter]);

  const selectedCampaignTxs = useMemo(() => {
    if (!selectedCampaign) return [];
    return transactions.filter((t) => t.campaignId === selectedCampaign.id);
  }, [selectedCampaign, transactions]);

  const updateStatus = async (camp: Campaign, nextStatus: CampaignStatus) => {
    if (!firebaseUser?.email || !permissions.canManageCampaigns) return;
    setBusyId(camp.id);
    setFeedback(null);
    try {
      await updateDoc(doc(db, 'campaigns', camp.id), {
        status: nextStatus,
        updatedAt: serverTimestamp(),
      });
      void recordAuditLog({
        action: `CAMPAIGN_${nextStatus.toUpperCase()}`,
        actorUid: firebaseUser.uid,
        actorEmail: firebaseUser.email,
        actorRole: role,
        targetType: 'campaign',
        targetId: camp.id,
        summary: `Changed campaign "${camp.name}" status from ${camp.status} to ${nextStatus}`,
      });
      setFeedback({ type: 'success', text: `Campaign "${camp.name}" marked as ${nextStatus}.` });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `campaigns/${camp.id}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleRunNow = async (camp: Campaign) => {
    if (!permissions.canSendBulk) return;
    setBusyId(camp.id);
    setFeedback(null);
    try {
      await runScheduledCampaignNow(camp);
      setFeedback({ type: 'success', text: `Dispatched campaign "${camp.name}".` });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Unable to run scheduled campaign.',
      });
    } finally {
      setBusyId(null);
    }
  };

  const handleRetryFailed = async (camp: Campaign) => {
    if (!permissions.canSendBulk) return;
    setBusyId(camp.id);
    setFeedback(null);
    try {
      const result = await retryFailedForCampaign(camp);
      setFeedback({
        type: 'success',
        text: `Retried ${result.retried} failed messages for "${camp.name}": ${result.succeeded} succeeded.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Retry failed.',
      });
    } finally {
      setBusyId(null);
    }
  };

  const handleSyncReport = async (camp: Campaign) => {
    setSyncing(true);
    setFeedback(null);
    try {
      const campTxs = transactions.filter((t) => t.campaignId === camp.id);
      const count = await syncDeliveryReports(campTxs);
      setFeedback({
        type: 'success',
        text:
          count > 0
            ? `Updated delivery status for ${count} messages from SMS.io.`
            : 'All tracked messages are already up to date.',
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to sync delivery reports from SMS.io.',
      });
    } finally {
      setSyncing(false);
    }
  };

  const statusColor = (status: CampaignStatus) => {
    switch (status) {
      case 'completed':
        return 'text-emerald-700';
      case 'failed':
      case 'cancelled':
        return 'text-red-600';
      case 'paused':
        return 'text-amber-700';
      default:
        return 'text-blue-700';
    }
  };

  return (
    <div className="space-y-6">
      {feedback && (
        <div
          className={`rounded-2xl p-4 border flex items-center justify-between gap-3 text-sm ${
            feedback.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-red-50 border-red-200 text-red-700'
          }`}
        >
          <div className="flex items-center gap-2.5">
            {feedback.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 shrink-0" />
            )}
            <span>{feedback.text}</span>
          </div>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="p-1 rounded-lg hover:bg-black/5 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Top Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-xl overflow-x-auto">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setStatusFilter(f.id)}
              className={`min-h-[38px] px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                statusFilter === f.id
                  ? 'bg-white text-blue-700 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => onNavigate('send')}
          className="min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-xs sm:text-sm font-semibold px-4 cursor-pointer whitespace-nowrap shrink-0"
        >
          <Plus className="w-4 h-4" />
          Create Campaign
        </button>
      </div>

      {/* Campaign List */}
      <div className="space-y-3">
        {filteredCampaigns.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center space-y-3">
            <p className="font-display text-base font-bold text-slate-800">
              No campaigns match this filter
            </p>
            <p className="text-xs text-slate-500">
              Create a new bulk SMS campaign or switch the status filter above.
            </p>
          </div>
        ) : (
          filteredCampaigns.map((camp) => {
            const isBusy = busyId === camp.id;
            const canPauseOrCancel = camp.status === 'scheduled' || camp.status === 'paused';
            return (
              <div
                key={camp.id}
                className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4"
              >
                <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
                  <div className="space-y-1.5 min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-display text-base font-bold text-slate-900">
                        {camp.name}
                      </h3>
                      <span className="text-slate-300">·</span>
                      <span className={`text-xs font-semibold capitalize ${statusColor(camp.status)}`}>
                        {camp.status}
                      </span>
                    </div>

                    <p className="text-xs text-slate-500">
                      Sender: <span className="font-mono text-slate-700">{camp.senderId}</span> · Created{' '}
                      {formatTimestamp(camp.createdAt)} by {camp.createdByEmail}
                      {camp.scheduledAt && ` · Scheduled: ${formatTimestamp(camp.scheduledAt)}`}
                    </p>

                    {camp.groupIds.length > 0 && (
                      <p className="text-xs text-slate-500">
                        Groups:{' '}
                        {camp.groupIds
                          .map((id) => groupMap.get(id) || id)
                          .join(', ')}
                      </p>
                    )}

                    <p className="text-sm text-slate-700 bg-slate-50 border border-slate-100 rounded-xl p-3 line-clamp-2">
                      {camp.messageTemplate}
                    </p>
                  </div>

                  {/* Metrics Grid */}
                  <div className="grid grid-cols-4 md:grid-cols-2 gap-3 md:w-56 shrink-0 text-xs">
                    <div>
                      <p className="text-slate-500">Recipients</p>
                      <p className="font-mono tabular-nums text-base font-bold text-slate-900">
                        {camp.recipientCount}
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-500">Sent</p>
                      <p className="font-mono tabular-nums text-base font-bold text-blue-700">
                        {camp.sentCount}
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-500">Delivered</p>
                      <p className="font-mono tabular-nums text-base font-bold text-emerald-700">
                        {camp.deliveredCount}
                      </p>
                    </div>
                    <div>
                      <p className="text-slate-500">Failed</p>
                      <p className="font-mono tabular-nums text-base font-bold text-red-600">
                        {camp.failedCount}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Action Row */}
                <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-mono tabular-nums text-slate-500">
                    {camp.estimatedSegments} est. segments · Spend: {camp.currency || 'USD'}{' '}
                    {(camp.actualCost || 0).toFixed(4)}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setSelectedCampaign(camp)}
                      className="min-h-[40px] inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-slate-300 hover:bg-slate-50 text-xs font-semibold text-slate-700 cursor-pointer whitespace-nowrap"
                    >
                      <Eye className="w-3.5 h-3.5" />
                      Delivery Report
                    </button>

                    {canPauseOrCancel && permissions.canSendBulk && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void handleRunNow(camp)}
                        className="min-h-[40px] inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold cursor-pointer disabled:opacity-50 whitespace-nowrap"
                      >
                        <Play className="w-3.5 h-3.5" />
                        Send Now
                      </button>
                    )}

                    {camp.status === 'scheduled' && permissions.canManageCampaigns && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void updateStatus(camp, 'paused')}
                        className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-amber-300 hover:bg-amber-50 text-amber-800 text-xs font-semibold cursor-pointer disabled:opacity-50 whitespace-nowrap"
                      >
                        <Pause className="w-3.5 h-3.5" />
                        Pause
                      </button>
                    )}

                    {canPauseOrCancel && permissions.canManageCampaigns && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void updateStatus(camp, 'cancelled')}
                        className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-red-200 hover:bg-red-50 text-red-700 text-xs font-semibold cursor-pointer disabled:opacity-50 whitespace-nowrap"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                        Cancel
                      </button>
                    )}

                    {camp.failedCount > 0 && permissions.canSendBulk && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void handleRetryFailed(camp)}
                        className="min-h-[40px] inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-semibold cursor-pointer disabled:opacity-50 whitespace-nowrap"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        {isBusy ? 'Retrying...' : `Retry ${camp.failedCount} Failed`}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Delivery Report Drawer Modal */}
      {selectedCampaign && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setSelectedCampaign(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full sm:max-w-3xl bg-white rounded-t-3xl sm:rounded-2xl p-6 space-y-4 border border-slate-200 max-h-[88vh] flex flex-col"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-display text-lg font-bold text-slate-900">
                  {selectedCampaign.name} — Delivery Report
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  {selectedCampaignTxs.length} logged transactions · Sender {selectedCampaign.senderId}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={syncing}
                  onClick={() => void handleSyncReport(selectedCampaign)}
                  className="min-h-[38px] inline-flex items-center gap-1.5 px-3 rounded-xl border border-slate-300 hover:bg-slate-50 text-xs font-semibold text-slate-700 cursor-pointer disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
                  Sync Status
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedCampaign(null)}
                  className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-xl hover:bg-slate-100 cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto border border-slate-200 rounded-xl divide-y divide-slate-100">
              {selectedCampaignTxs.length === 0 ? (
                <p className="p-6 text-center text-xs text-slate-500">
                  No SMS transactions dispatched for this campaign yet.
                </p>
              ) : (
                selectedCampaignTxs.map((tx) => (
                  <div key={tx.id} className="p-3.5 space-y-1 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono font-semibold text-slate-900">
                        {tx.recipientPhone}{' '}
                        <span className="font-sans font-normal text-slate-500">
                          ({tx.recipientName})
                        </span>
                      </span>
                      <span
                        className={`font-semibold uppercase ${
                          tx.status === 'delivered'
                            ? 'text-emerald-700'
                            : tx.status === 'sent'
                              ? 'text-blue-700'
                              : tx.status === 'pending'
                                ? 'text-amber-700'
                                : 'text-red-600'
                        }`}
                      >
                        {tx.status} · HTTP {tx.httpStatus}
                      </span>
                    </div>
                    <p className="text-slate-600">{tx.messageContent}</p>
                    <p className="font-mono text-[11px] text-slate-500 break-all">
                      ID: {tx.providerMessageId || '—'} · {tx.segments} seg · {tx.currency}{' '}
                      {tx.cost.toFixed(4)} · API: {tx.apiResponseSummary || '—'}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
