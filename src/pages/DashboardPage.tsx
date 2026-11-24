import { useMemo, useState } from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import {
  RefreshCw,
  Send,
  Users,
  AlertTriangle,
  ArrowRight,
  Wallet,
} from 'lucide-react';
import { usePortalData } from '../context/PortalDataContext';
import { formatTimestamp } from '../lib/smsUtils';
import type { PortalTab } from '../types/portal';

type ReportPeriod = 'daily' | 'weekly' | 'monthly';

export function DashboardPage({ onNavigate }: { onNavigate: (tab: PortalTab) => void }) {
  const {
    contacts,
    groups,
    campaigns,
    transactions,
    dataLoading,
    gatewayConfig,
    gatewayBalance,
    balanceLoading,
    refreshGatewayInfo,
  } = usePortalData();

  const [period, setPeriod] = useState<ReportPeriod>('daily');

  const stats = useMemo(() => {
    const totalSent = transactions.length;
    const successful = transactions.filter(
      (t) => t.status === 'delivered' || t.status === 'sent'
    ).length;
    const delivered = transactions.filter((t) => t.status === 'delivered').length;
    const failed = transactions.filter(
      (t) => t.status === 'failed' || t.status === 'rejected'
    ).length;
    const pending = transactions.filter((t) => t.status === 'pending').length;
    const totalSegments = transactions.reduce((acc, t) => acc + (t.segments || 1), 0);
    const totalSpend = transactions.reduce((acc, t) => acc + (t.cost || 0), 0);
    const deliveryRate = totalSent > 0 ? Math.round((successful / totalSent) * 100) : 0;

    return {
      totalSent,
      successful,
      delivered,
      failed,
      pending,
      totalSegments,
      totalSpend,
      deliveryRate,
    };
  }, [transactions]);

  const chartData = useMemo(() => {
    const now = new Date();
    const buckets: { key: string; label: string; successful: number; failed: number; pending: number }[] = [];

    if (period === 'daily') {
      // Last 7 days
      for (let i = 6; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(now.getDate() - i);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const label = d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' });
        buckets.push({ key, label, successful: 0, failed: 0, pending: 0 });
      }
      for (const tx of transactions) {
        if (!tx.createdAt?.toDate) continue;
        const d = tx.createdAt.toDate();
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const b = buckets.find((x) => x.key === key);
        if (!b) continue;
        if (tx.status === 'delivered' || tx.status === 'sent') b.successful += 1;
        else if (tx.status === 'failed' || tx.status === 'rejected') b.failed += 1;
        else b.pending += 1;
      }
    } else if (period === 'weekly') {
      // Last 6 weeks
      for (let i = 5; i >= 0; i--) {
        const start = new Date(now);
        start.setDate(now.getDate() - i * 7 - 6);
        const end = new Date(now);
        end.setDate(now.getDate() - i * 7);
        const label = `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
        buckets.push({ key: `${start.getTime()}_${end.getTime()}`, label, successful: 0, failed: 0, pending: 0 });
      }
      for (const tx of transactions) {
        if (!tx.createdAt?.toDate) continue;
        const ms = tx.createdAt.toDate().getTime();
        for (const b of buckets) {
          const [s, e] = b.key.split('_').map(Number);
          if (ms >= s && ms <= e + 86400000) {
            if (tx.status === 'delivered' || tx.status === 'sent') b.successful += 1;
            else if (tx.status === 'failed' || tx.status === 'rejected') b.failed += 1;
            else b.pending += 1;
            break;
          }
        }
      }
    } else {
      // Last 6 months
      for (let i = 5; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        const label = d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
        buckets.push({ key, label, successful: 0, failed: 0, pending: 0 });
      }
      for (const tx of transactions) {
        if (!tx.createdAt?.toDate) continue;
        const d = tx.createdAt.toDate();
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        const b = buckets.find((x) => x.key === key);
        if (!b) continue;
        if (tx.status === 'delivered' || tx.status === 'sent') b.successful += 1;
        else if (tx.status === 'failed' || tx.status === 'rejected') b.failed += 1;
        else b.pending += 1;
      }
    }

    return buckets;
  }, [transactions, period]);

  const recentCampaigns = campaigns.slice(0, 6);

  return (
    <div className="space-y-6">
      {/* Gateway Configuration Alert if SMS_IO_API_KEY is missing */}
      {gatewayConfig && !gatewayConfig.configured && (
        <div className="bg-white border border-red-200 rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-red-50 text-red-600 flex items-center justify-center shrink-0">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div className="space-y-0.5">
              <h2 className="font-display text-sm font-bold text-slate-900">
                SMS_IO_API_KEY Environment Variable Not Set
              </h2>
              <p className="text-xs text-slate-600 leading-relaxed">
                Add <code className="font-mono bg-slate-100 px-1.5 py-0.5 rounded text-slate-800">SMS_IO_API_KEY</code> in
                your server environment or Vercel Project Settings to enable live balance checks and
                SMS dispatch through <span className="font-mono">{gatewayConfig.apiBaseUrl}</span>.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('audit')}
            className="min-h-[42px] px-4 py-2 rounded-xl border border-slate-300 hover:bg-slate-50 text-xs font-semibold text-slate-800 cursor-pointer whitespace-nowrap shrink-0"
          >
            Gateway Details
          </button>
        </div>
      )}

      {/* Primary KPI Grid */}
      <section className="grid grid-cols-2 lg:grid-cols-5 gap-3 sm:gap-4" aria-label="Key Metrics">
        <div className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 space-y-1.5">
          <p className="text-xs font-medium text-slate-500">Total SMS Sent</p>
          <p className="font-mono tabular-nums text-2xl sm:text-3xl font-semibold text-slate-900">
            {dataLoading ? '—' : stats.totalSent.toLocaleString()}
          </p>
          <p className="text-xs text-slate-500 font-mono tabular-nums">
            {stats.totalSegments.toLocaleString()} segments
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 space-y-1.5">
          <p className="text-xs font-medium text-slate-500">Successful</p>
          <p className="font-mono tabular-nums text-2xl sm:text-3xl font-semibold text-blue-700">
            {dataLoading ? '—' : stats.successful.toLocaleString()}
          </p>
          <p className="text-xs text-slate-500 font-mono tabular-nums">
            {stats.deliveryRate}% success · {stats.delivered} delivered
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 space-y-1.5">
          <p className="text-xs font-medium text-slate-500">Failed</p>
          <p className="font-mono tabular-nums text-2xl sm:text-3xl font-semibold text-red-600">
            {dataLoading ? '—' : stats.failed.toLocaleString()}
          </p>
          <p className="text-xs text-slate-500 font-mono tabular-nums">
            {stats.pending} pending queue
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 space-y-1.5">
          <p className="text-xs font-medium text-slate-500">Total Contacts</p>
          <p className="font-mono tabular-nums text-2xl sm:text-3xl font-semibold text-slate-900">
            {dataLoading ? '—' : contacts.length.toLocaleString()}
          </p>
          <p className="text-xs text-slate-500">
            {groups.length} saved {groups.length === 1 ? 'group' : 'groups'}
          </p>
        </div>

        <div className="col-span-2 lg:col-span-1 bg-slate-950 text-white rounded-2xl p-4 sm:p-5 flex flex-col justify-between space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-slate-300 flex items-center gap-1.5">
              <Wallet className="w-3.5 h-3.5 text-blue-400" />
              SMS.io Balance
            </span>
            <button
              type="button"
              onClick={() => void refreshGatewayInfo()}
              disabled={balanceLoading}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer disabled:opacity-50"
              aria-label="Refresh SMS.io balance"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${balanceLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
          <p className="font-mono tabular-nums text-2xl sm:text-3xl font-semibold text-white">
            {balanceLoading
              ? '...'
              : gatewayBalance?.balance !== null && gatewayBalance?.balance !== undefined
                ? `${gatewayBalance.currency} ${gatewayBalance.balance.toFixed(2)}`
                : 'N/A'}
          </p>
          <p className="text-xs text-slate-400 truncate">
            {gatewayBalance?.configured
              ? gatewayBalance.error || `Tracked spend: $${stats.totalSpend.toFixed(2)}`
              : 'Set SMS_IO_API_KEY'}
          </p>
        </div>
      </section>

      {/* Quick Action Bar */}
      <section className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
        <button
          type="button"
          onClick={() => onNavigate('send')}
          className="min-h-[60px] bg-blue-700 hover:bg-blue-800 text-white rounded-2xl px-5 py-4 flex items-center justify-between transition-colors cursor-pointer text-left"
        >
          <div className="flex items-center gap-3.5">
            <div className="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center shrink-0">
              <Send className="w-5 h-5" />
            </div>
            <div>
              <p className="font-display font-bold text-sm sm:text-base">Send Bulk SMS Campaign</p>
              <p className="text-xs text-blue-100">Manual numbers, groups, or Excel/CSV upload</p>
            </div>
          </div>
          <ArrowRight className="w-5 h-5 shrink-0" />
        </button>

        <button
          type="button"
          onClick={() => onNavigate('contacts')}
          className="min-h-[60px] bg-white hover:bg-slate-50 border border-slate-200 text-slate-900 rounded-2xl px-5 py-4 flex items-center justify-between transition-colors cursor-pointer text-left"
        >
          <div className="flex items-center gap-3.5">
            <div className="w-10 h-10 rounded-xl bg-red-50 text-red-600 flex items-center justify-center shrink-0">
              <Users className="w-5 h-5" />
            </div>
            <div>
              <p className="font-display font-bold text-sm sm:text-base">Manage & Import Contacts</p>
              <p className="text-xs text-slate-500">Upload Excel/CSV, organize groups & deduplicate</p>
            </div>
          </div>
          <ArrowRight className="w-5 h-5 text-slate-400 shrink-0" />
        </button>
      </section>

      {/* Usage Chart & Reports */}
      <section className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-base sm:text-lg font-bold text-slate-900">
              SMS Usage & Delivery Statistics
            </h2>
            <p className="text-xs text-slate-500">
              {period === 'daily'
                ? 'Last 7 days transaction breakdown'
                : period === 'weekly'
                  ? 'Last 6 weeks transaction breakdown'
                  : 'Last 6 months transaction breakdown'}
            </p>
          </div>

          <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-xl self-start">
            {(['daily', 'weekly', 'monthly'] as ReportPeriod[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPeriod(p)}
                className={`min-h-[36px] px-3.5 py-1.5 rounded-lg text-xs font-semibold capitalize transition-colors cursor-pointer whitespace-nowrap ${
                  period === p
                    ? 'bg-white text-blue-700 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        <div className="h-64 sm:h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#64748B' }} axisLine={false} tickLine={false} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: '#64748B' }} axisLine={false} tickLine={false} />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#0F172A',
                  border: 'none',
                  borderRadius: '12px',
                  color: '#FFFFFF',
                  fontSize: '12px',
                }}
              />
              <Legend wrapperStyle={{ fontSize: '12px' }} />
              <Bar dataKey="successful" name="Sent / Delivered" fill="#1D4ED8" radius={[6, 6, 0, 0]} maxBarSize={36} />
              <Bar dataKey="failed" name="Failed" fill="#DC2626" radius={[6, 6, 0, 0]} maxBarSize={36} />
              <Bar dataKey="pending" name="Pending" fill="#94A3B8" radius={[6, 6, 0, 0]} maxBarSize={36} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* Recent SMS Campaigns */}
      <section className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <div>
            <h2 className="font-display text-base font-bold text-slate-900">Recent SMS Campaigns</h2>
            <p className="text-xs text-slate-500">Latest bulk and scheduled dispatches</p>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('campaigns')}
            className="text-xs font-semibold text-blue-700 hover:text-blue-800 cursor-pointer whitespace-nowrap"
          >
            View All Campaigns
          </button>
        </div>

        {recentCampaigns.length === 0 ? (
          <div className="p-8 text-center space-y-3">
            <p className="text-sm font-semibold text-slate-800">No SMS campaigns yet</p>
            <p className="text-xs text-slate-500 max-w-sm mx-auto">
              Compose your first bulk SMS campaign to see delivery reports, segment usage, and
              real-time performance here.
            </p>
            <button
              type="button"
              onClick={() => onNavigate('send')}
              className="min-h-[42px] inline-flex items-center gap-2 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold px-4 py-2 cursor-pointer"
            >
              <Send className="w-3.5 h-3.5" />
              Create First Campaign
            </button>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {recentCampaigns.map((camp) => (
              <div
                key={camp.id}
                onClick={() => onNavigate('campaigns')}
                className="px-5 py-3.5 hover:bg-slate-50 transition-colors cursor-pointer flex flex-col sm:flex-row sm:items-center justify-between gap-2"
              >
                <div className="min-w-0 space-y-0.5">
                  <p className="text-sm font-semibold text-slate-900 truncate">{camp.name}</p>
                  <p className="text-xs text-slate-500 truncate">
                    Sender: {camp.senderId} · {formatTimestamp(camp.createdAt)} ·{' '}
                    <span
                      className={`font-semibold capitalize ${
                        camp.status === 'completed'
                          ? 'text-emerald-700'
                          : camp.status === 'failed' || camp.status === 'cancelled'
                            ? 'text-red-600'
                            : 'text-blue-700'
                      }`}
                    >
                      {camp.status}
                    </span>
                  </p>
                </div>

                <div className="flex items-center gap-4 text-xs font-mono tabular-nums text-slate-600 shrink-0">
                  <span>{camp.recipientCount} recipients</span>
                  <span className="text-blue-700 font-semibold">{camp.sentCount} sent</span>
                  {camp.failedCount > 0 && (
                    <span className="text-red-600 font-semibold">{camp.failedCount} failed</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
