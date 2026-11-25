import { useMemo, useState } from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
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
  Smartphone,
  ArrowRight,
} from 'lucide-react';
import { usePortalData } from '../context/PortalDataContext';
import { ConnectMobileDevice } from '../components/ConnectMobileDevice';
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
    simBridgeStatus,
    bridgeLoading,
    refreshSimBridgeStatus,
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
    const deliveryRate = totalSent > 0 ? Math.round((successful / totalSent) * 100) : 0;

    return {
      totalSent,
      successful,
      delivered,
      failed,
      pending,
      totalSegments,
      deliveryRate,
    };
  }, [transactions]);

  const activeSimDevice = useMemo(
    () => simBridgeStatus?.devices.find((d) => d.online) || simBridgeStatus?.devices[0] || null,
    [simBridgeStatus]
  );

  const scrollToConnectDevice = () => {
    document.getElementById('connect-mobile-device')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // 30-day SMS Sent vs. Failed trend data for the Recharts LineChart
  const thirtyDayTrendData = useMemo(() => {
    const now = new Date();
    const days: { key: string; label: string; sent: number; failed: number }[] = [];

    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      days.push({ key, label, sent: 0, failed: 0 });
    }

    const dayMap = new Map(days.map((d) => [d.key, d]));

    for (const tx of transactions) {
      if (!tx.createdAt?.toDate) continue;
      const d = tx.createdAt.toDate();
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const bucket = dayMap.get(key);
      if (!bucket) continue;
      if (tx.status === 'failed' || tx.status === 'rejected') {
        bucket.failed += 1;
      } else {
        bucket.sent += 1;
      }
    }

    return days;
  }, [transactions]);

  const thirtyDayTotals = useMemo(() => {
    return thirtyDayTrendData.reduce(
      (acc, d) => ({ sent: acc.sent + d.sent, failed: acc.failed + d.failed }),
      { sent: 0, failed: 0 }
    );
  }, [thirtyDayTrendData]);

  const chartData = useMemo(() => {
    const now = new Date();
    const buckets: { key: string; label: string; successful: number; failed: number; pending: number }[] = [];

    if (period === 'daily') {
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
      {/* Prompt to link Android SIM phone when no device is currently online */}
      {simBridgeStatus && !simBridgeStatus.simBridgeReady && (
        <div className="bg-white border border-blue-200 rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-700 flex items-center justify-center shrink-0">
              <Smartphone className="w-5 h-5" />
            </div>
            <div className="space-y-0.5">
              <h2 className="font-display text-sm font-bold text-slate-900">
                Link Your Android Phone to Send via SIM Card
              </h2>
              <p className="text-xs text-slate-600 leading-relaxed">
                No Android handset is currently online. Scan the QR code below with the ZACMA
                companion app to send bulk SMS directly from your own mobile number and SIM package —
                no paid third-party gateway required.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={scrollToConnectDevice}
            className="min-h-[42px] px-4 py-2 rounded-xl bg-blue-700 hover:bg-blue-800 text-xs font-semibold text-white cursor-pointer whitespace-nowrap shrink-0"
          >
            Pair Android SIM
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
              <Smartphone className="w-3.5 h-3.5 text-blue-400" />
              Android SIM Bridge
            </span>
            <button
              type="button"
              onClick={() => void refreshSimBridgeStatus()}
              disabled={bridgeLoading}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer disabled:opacity-50"
              aria-label="Refresh Android SIM bridge status"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${bridgeLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
          <p className="font-mono tabular-nums text-2xl sm:text-3xl font-semibold text-white">
            {bridgeLoading
              ? '...'
              : simBridgeStatus?.simBridgeReady
                ? `${simBridgeStatus.onlineDevicesCount} Online`
                : '0 Online'}
          </p>
          <p className="text-xs text-slate-400 truncate">
            {activeSimDevice
              ? `${activeSimDevice.phoneNumber} · ${activeSimDevice.carrierName}`
              : 'Direct SIM · Zero API fees'}
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

      {/* Connect Mobile Device (Android SIM Bridge QR Pairing) */}
      <ConnectMobileDevice />

      {/* 30-Day SMS Sent vs. Failed Line Chart */}
      <section className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-base sm:text-lg font-bold text-slate-900">
              SMS Sent vs. Failed — Last 30 Days
            </h2>
            <p className="text-xs text-slate-500">
              Daily dispatch volume trend across all campaigns
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs font-mono tabular-nums text-slate-600">
            <span className="text-blue-700 font-semibold">
              {thirtyDayTotals.sent.toLocaleString()} sent
            </span>
            <span aria-hidden="true">·</span>
            <span className="text-red-600 font-semibold">
              {thirtyDayTotals.failed.toLocaleString()} failed
            </span>
          </div>
        </div>

        <div className="h-64 sm:h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={thirtyDayTrendData} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} />
              <XAxis
                dataKey="label"
                interval={4}
                tick={{ fontSize: 11, fill: '#64748B' }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                allowDecimals={false}
                tick={{ fontSize: 12, fill: '#64748B' }}
                axisLine={false}
                tickLine={false}
              />
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
              <Line
                type="monotone"
                dataKey="sent"
                name="SMS Sent"
                stroke="#1D4ED8"
                strokeWidth={2.5}
                dot={{ r: 2.5, fill: '#1D4ED8' }}
                activeDot={{ r: 5 }}
              />
              <Line
                type="monotone"
                dataKey="failed"
                name="SMS Failed"
                stroke="#DC2626"
                strokeWidth={2.5}
                dot={{ r: 2.5, fill: '#DC2626' }}
                activeDot={{ r: 5 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* Usage Chart & Reports (Daily / Weekly / Monthly Breakdown) */}
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
