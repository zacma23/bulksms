import { useMemo, useState } from 'react';
import {
  Search,
  RefreshCw,
  Download,
  RotateCcw,
  X,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { usePortalData } from '../context/PortalDataContext';
import { exportRowsToCsv, exportRowsToExcel, formatTimestamp } from '../lib/smsUtils';
import type { SmsDeliveryStatus, SmsTransaction } from '../types/portal';

type StatusFilter = 'all' | 'successful' | SmsDeliveryStatus;
type DateRangeFilter = 'all' | 'today' | '7d' | '30d';

export function HistoryPage() {
  const { permissions } = useAuth();
  const { transactions, campaigns, syncDeliveryReports, retrySingleTransaction } = usePortalData();

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [campaignFilter, setCampaignFilter] = useState<string>('all');
  const [dateRange, setDateRange] = useState<DateRangeFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTx, setSelectedTx] = useState<SmsTransaction | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const filteredTransactions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const now = Date.now();

    return transactions.filter((tx) => {
      if (statusFilter === 'successful') {
        if (tx.status !== 'sent' && tx.status !== 'delivered') return false;
      } else if (statusFilter !== 'all' && tx.status !== statusFilter) {
        return false;
      }

      if (campaignFilter !== 'all' && tx.campaignId !== campaignFilter) return false;

      if (dateRange !== 'all' && tx.createdAt?.toDate) {
        const ms = tx.createdAt.toDate().getTime();
        const diffDays = (now - ms) / (1000 * 60 * 60 * 24);
        if (dateRange === 'today' && diffDays > 1) return false;
        if (dateRange === '7d' && diffDays > 7) return false;
        if (dateRange === '30d' && diffDays > 30) return false;
      }

      if (!q) return true;
      return (
        tx.recipientPhone.toLowerCase().includes(q) ||
        tx.recipientName.toLowerCase().includes(q) ||
        tx.campaignName.toLowerCase().includes(q) ||
        tx.messageContent.toLowerCase().includes(q) ||
        tx.providerMessageId.toLowerCase().includes(q)
      );
    });
  }, [transactions, statusFilter, campaignFilter, dateRange, searchQuery]);

  const handleSyncStatuses = async () => {
    setSyncing(true);
    setFeedback(null);
    try {
      const updated = await syncDeliveryReports(filteredTransactions);
      setFeedback({
        type: 'success',
        text:
          updated > 0
            ? `Synchronized Android SIM delivery receipts for ${updated} messages.`
            : 'No new SIM delivery receipt updates recorded yet.',
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Unable to sync SIM delivery statuses.',
      });
    } finally {
      setSyncing(false);
    }
  };

  const handleRetryTx = async (tx: SmsTransaction) => {
    if (!permissions.canSendBulk) return;
    setRetryingId(tx.id);
    setFeedback(null);
    try {
      const ok = await retrySingleTransaction(tx);
      setFeedback({
        type: ok ? 'success' : 'error',
        text: ok
          ? `Retried SMS to ${tx.recipientPhone} successfully.`
          : `Retry to ${tx.recipientPhone} failed again. Inspect API response for details.`,
      });
      setSelectedTx(null);
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Retry request failed.',
      });
    } finally {
      setRetryingId(null);
    }
  };

  const handleExport = (format: 'xlsx' | 'csv') => {
    const rows = filteredTransactions.map((tx) => ({
      Date: formatTimestamp(tx.createdAt),
      Campaign: tx.campaignName,
      Recipient: tx.recipientName,
      Phone: tx.recipientPhone,
      Message: tx.messageContent,
      SimLine: tx.senderId,
      Status: tx.status,
      Segments: tx.segments,
      SimDispatchId: tx.providerMessageId,
      HttpStatus: tx.httpStatus,
      SimResponse: tx.apiResponseSummary,
    }));
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'xlsx') {
      exportRowsToExcel(rows, `zacma_sms_history_${stamp}.xlsx`, 'SMS History');
    } else {
      exportRowsToCsv(rows, `zacma_sms_history_${stamp}.csv`);
    }
  };

  const statusTextStyle = (s: SmsDeliveryStatus) => {
    if (s === 'delivered') return 'text-emerald-700 font-semibold';
    if (s === 'sent') return 'text-blue-700 font-semibold';
    if (s === 'pending') return 'text-amber-700 font-semibold';
    return 'text-red-600 font-semibold';
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

      {/* Filter & Export Controls */}
      <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-xl overflow-x-auto">
            {(
              [
                ['all', 'All'],
                ['successful', 'Successful'],
                ['delivered', 'Delivered'],
                ['pending', 'Pending'],
                ['failed', 'Failed'],
                ['rejected', 'Rejected'],
              ] as Array<[StatusFilter, string]>
            ).map(([val, label]) => (
              <button
                key={val}
                type="button"
                onClick={() => setStatusFilter(val)}
                className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                  statusFilter === val
                    ? 'bg-white text-blue-700 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={syncing}
              onClick={() => void handleSyncStatuses()}
              className="min-h-[42px] inline-flex items-center gap-1.5 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold px-3.5 cursor-pointer disabled:opacity-50 whitespace-nowrap"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
              Sync Delivery Status
            </button>
            <button
              type="button"
              onClick={() => handleExport('xlsx')}
              disabled={filteredTransactions.length === 0}
              className="min-h-[42px] inline-flex items-center gap-1.5 rounded-xl border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-semibold px-3.5 cursor-pointer disabled:opacity-50 whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              Excel
            </button>
            <button
              type="button"
              onClick={() => handleExport('csv')}
              disabled={filteredTransactions.length === 0}
              className="min-h-[42px] inline-flex items-center gap-1.5 rounded-xl border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-semibold px-3.5 cursor-pointer disabled:opacity-50 whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              CSV
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search phone, message, or ID..."
              className="w-full min-h-[42px] pl-10 pr-3 py-2 rounded-xl border border-slate-300 text-xs sm:text-sm"
            />
          </div>

          <select
            value={campaignFilter}
            onChange={(e) => setCampaignFilter(e.target.value)}
            className="w-full min-h-[42px] px-3 rounded-xl border border-slate-300 text-xs sm:text-sm bg-white"
          >
            <option value="all">All Campaigns ({campaigns.length})</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>

          <select
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value as DateRangeFilter)}
            className="w-full min-h-[42px] px-3 rounded-xl border border-slate-300 text-xs sm:text-sm bg-white"
          >
            <option value="all">All Time</option>
            <option value="today">Last 24 Hours</option>
            <option value="7d">Last 7 Days</option>
            <option value="30d">Last 30 Days</option>
          </select>
        </div>
      </div>

      {/* Transaction History Table / Mobile Cards */}
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        {filteredTransactions.length === 0 ? (
          <div className="p-10 text-center space-y-2">
            <p className="font-display text-base font-bold text-slate-800">
              No SMS transactions recorded
            </p>
            <p className="text-xs text-slate-500">
              Once messages are dispatched through your paired Android phone SIM card, full logs,
              segments, and delivery receipts appear here.
            </p>
          </div>
        ) : (
          <>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                    <th className="py-3 px-4">Date &amp; Time</th>
                    <th className="py-3 px-4">Recipient</th>
                    <th className="py-3 px-4">Campaign</th>
                    <th className="py-3 px-4">Message</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4">SIM Line</th>
                    <th className="py-3 px-4 text-right">Segments</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs sm:text-sm">
                  {filteredTransactions.map((tx) => (
                    <tr
                      key={tx.id}
                      onClick={() => setSelectedTx(tx)}
                      className="hover:bg-slate-50 cursor-pointer transition-colors"
                    >
                      <td className="py-3 px-4 font-mono tabular-nums text-xs text-slate-500 whitespace-nowrap">
                        {formatTimestamp(tx.createdAt)}
                      </td>
                      <td className="py-3 px-4">
                        <p className="font-mono tabular-nums font-medium text-slate-900">
                          {tx.recipientPhone}
                        </p>
                        <p className="text-xs text-slate-500 truncate max-w-[140px]">
                          {tx.recipientName}
                        </p>
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-700 max-w-[160px] truncate">
                        {tx.campaignName}
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-600 max-w-[240px] truncate">
                        {tx.messageContent}
                      </td>
                      <td className={`py-3 px-4 text-xs capitalize ${statusTextStyle(tx.status)}`}>
                        {tx.status}
                      </td>
                      <td className="py-3 px-4 font-mono text-xs text-slate-700 whitespace-nowrap">
                        {tx.senderId || 'ANDROID-SIM'}
                      </td>
                      <td className="py-3 px-4 font-mono tabular-nums text-xs text-right text-slate-700">
                        {tx.segments}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="md:hidden divide-y divide-slate-100">
              {filteredTransactions.map((tx) => (
                <button
                  key={tx.id}
                  type="button"
                  onClick={() => setSelectedTx(tx)}
                  className="w-full p-4 text-left space-y-1.5 hover:bg-slate-50 cursor-pointer"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono tabular-nums text-sm font-semibold text-slate-900">
                      {tx.recipientPhone}
                    </span>
                    <span className={`text-xs capitalize ${statusTextStyle(tx.status)}`}>
                      {tx.status}
                    </span>
                  </div>
                  <p className="text-xs text-slate-600 line-clamp-2">{tx.messageContent}</p>
                  <p className="text-[11px] text-slate-500">
                    {tx.campaignName} · {tx.segments} seg · {formatTimestamp(tx.createdAt)}
                  </p>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Transaction Detail Inspection Modal */}
      {selectedTx && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setSelectedTx(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full sm:max-w-lg bg-white rounded-t-3xl sm:rounded-2xl p-6 space-y-4 border border-slate-200 max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-display text-lg font-bold text-slate-900">
                  SMS Transaction Details
                </h3>
                <p className="font-mono text-xs text-slate-500">{selectedTx.recipientPhone}</p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedTx(null)}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <dl className="grid grid-cols-2 gap-3 text-xs bg-slate-50 border border-slate-200 rounded-xl p-4">
              <div>
                <dt className="text-slate-500">Status</dt>
                <dd className={`capitalize mt-0.5 ${statusTextStyle(selectedTx.status)}`}>
                  {selectedTx.status} (HTTP {selectedTx.httpStatus})
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Sent At</dt>
                <dd className="font-mono text-slate-800 mt-0.5">
                  {formatTimestamp(selectedTx.createdAt)}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Campaign</dt>
                <dd className="font-semibold text-slate-800 mt-0.5">{selectedTx.campaignName}</dd>
              </div>
              <div>
                <dt className="text-slate-500">SIM Line / Number</dt>
                <dd className="font-mono text-slate-800 mt-0.5">{selectedTx.senderId}</dd>
              </div>
              <div>
                <dt className="text-slate-500">SIM Segments</dt>
                <dd className="font-mono text-slate-800 mt-0.5">
                  {selectedTx.segments} {selectedTx.segments === 1 ? 'segment' : 'segments'} (Carrier SIM)
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">SIM Dispatch ID</dt>
                <dd className="font-mono text-slate-800 mt-0.5 break-all">
                  {selectedTx.providerMessageId || '—'}
                </dd>
              </div>
            </dl>

            <div className="space-y-1">
              <p className="text-xs font-semibold text-slate-700">Message Content</p>
              <p className="text-sm text-slate-800 bg-slate-50 border border-slate-200 rounded-xl p-3.5 whitespace-pre-wrap break-words">
                {selectedTx.messageContent}
              </p>
            </div>

            <div className="space-y-1">
              <p className="text-xs font-semibold text-slate-700">Android SIM Bridge Response</p>
              <pre className="text-[11px] font-mono bg-slate-950 text-slate-200 rounded-xl p-3.5 overflow-x-auto whitespace-pre-wrap break-all">
                {selectedTx.apiResponseSummary || 'No device response recorded.'}
              </pre>
            </div>

            <div className="flex gap-3 pt-2">
              {(selectedTx.status === 'failed' || selectedTx.status === 'rejected') &&
                permissions.canSendBulk && (
                  <button
                    type="button"
                    disabled={retryingId === selectedTx.id}
                    onClick={() => void handleRetryTx(selectedTx)}
                    className="flex-1 min-h-[46px] inline-flex items-center justify-center gap-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-sm font-semibold cursor-pointer disabled:opacity-50"
                  >
                    <RotateCcw className="w-4 h-4" />
                    {retryingId === selectedTx.id ? 'Retrying...' : 'Retry Message'}
                  </button>
                )}
              <button
                type="button"
                onClick={() => setSelectedTx(null)}
                className="flex-1 min-h-[46px] rounded-xl border border-slate-300 hover:bg-slate-50 text-slate-700 text-sm font-semibold cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
