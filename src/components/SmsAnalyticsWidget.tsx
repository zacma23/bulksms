import { useMemo, useState } from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  BarChart,
  Bar,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import { Send } from 'lucide-react';
import type { PortalTab, SmsTransaction } from '../types/portal';

type AnalyticsRange = '7d' | '14d' | '30d' | 'all';

const RANGE_OPTIONS: { value: AnalyticsRange; label: string }[] = [
  { value: '7d', label: '7D' },
  { value: '14d', label: '14D' },
  { value: '30d', label: '30D' },
  { value: 'all', label: 'All' },
];

const STATUS_COLORS = {
  delivered: '#16A34A',
  sent: '#1D4ED8',
  pending: '#94A3B8',
  failed: '#DC2626',
} as const;

const FAILURE_BAR_COLORS = ['#DC2626', '#EA580C', '#D97706', '#991B1B', '#64748B'];

interface DailyVolumePoint {
  key: string;
  label: string;
  delivered: number;
  sent: number;
  pending: number;
  failed: number;
  total: number;
  successRate: number | null;
}

interface FailureReasonPoint {
  reason: string;
  count: number;
  share: number;
}

function toDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`;
}

function classifyFailureReason(tx: SmsTransaction): string {
  const summary = `${tx.apiResponseSummary || ''}`.toLowerCase();
  const http = Number(tx.httpStatus || 0);

  if (
    http === 503 ||
    summary.includes('no linked') ||
    summary.includes('offline') ||
    summary.includes('disconnected')
  ) {
    return 'Phone Offline / Disconnected';
  }
  if (http === 504 || summary.includes('timed out') || summary.includes('timeout')) {
    return 'SIM Dispatch Timeout';
  }
  if (
    tx.status === 'rejected' ||
    http === 400 ||
    http === 422 ||
    summary.includes('invalid') ||
    summary.includes('e.164') ||
    summary.includes('rejected')
  ) {
    return 'Invalid Number / Rejected';
  }
  if (summary.includes('marked failed') || summary.includes('cancel')) {
    return 'Marked Failed on Handset';
  }
  if (
    http === 502 ||
    summary.includes('carrier') ||
    summary.includes('smsmanager') ||
    summary.includes('sim') ||
    summary.includes('network')
  ) {
    return 'Carrier / SIM Error';
  }
  if (summary.includes('permission') || http === 401 || http === 403) {
    return 'Permission / Auth Denied';
  }
  return 'Other Dispatch Error';
}

function getTxDate(tx: SmsTransaction): Date | null {
  if (tx.createdAt && typeof tx.createdAt.toDate === 'function') {
    return tx.createdAt.toDate();
  }
  return null;
}

interface SmsAnalyticsWidgetProps {
  transactions: SmsTransaction[];
  loading: boolean;
  onNavigate: (tab: PortalTab) => void;
}

export function SmsAnalyticsWidget({
  transactions,
  loading,
  onNavigate,
}: SmsAnalyticsWidgetProps) {
  const [range, setRange] = useState<AnalyticsRange>('14d');

  const analytics = useMemo(() => {
    const now = new Date();
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const rangeDays = range === '7d' ? 7 : range === '14d' ? 14 : range === '30d' ? 30 : null;

    const cutoffMs = rangeDays
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - (rangeDays - 1)).getTime()
      : 0;

    const filtered = transactions.filter((tx) => {
      if (!rangeDays) return true;
      const d = getTxDate(tx);
      if (!d) return false;
      return d.getTime() >= cutoffMs && d.getTime() <= todayEnd.getTime();
    });

    let delivered = 0;
    let sent = 0;
    let pending = 0;
    let failed = 0;
    let rejected = 0;

    const failureCounts = new Map<string, number>();

    for (const tx of filtered) {
      if (tx.status === 'delivered') delivered += 1;
      else if (tx.status === 'sent') sent += 1;
      else if (tx.status === 'pending') pending += 1;
      else if (tx.status === 'rejected') {
        rejected += 1;
        const reason = classifyFailureReason(tx);
        failureCounts.set(reason, (failureCounts.get(reason) || 0) + 1);
      } else {
        failed += 1;
        const reason = classifyFailureReason(tx);
        failureCounts.set(reason, (failureCounts.get(reason) || 0) + 1);
      }
    }

    const total = filtered.length;
    const totalSuccessful = delivered + sent;
    const totalFailed = failed + rejected;
    const finalizedTotal = totalSuccessful + totalFailed;
    const successRate =
      finalizedTotal > 0 ? Number(((totalSuccessful / finalizedTotal) * 100).toFixed(1)) : 0;
    const failureRate =
      finalizedTotal > 0 ? Number(((totalFailed / finalizedTotal) * 100).toFixed(1)) : 0;

    // Build daily volume series
    const dayBuckets: DailyVolumePoint[] = [];
    let spanDays = rangeDays || 14;

    if (rangeDays) {
      for (let i = rangeDays - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        dayBuckets.push({
          key: toDayKey(d),
          label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          delivered: 0,
          sent: 0,
          pending: 0,
          failed: 0,
          total: 0,
          successRate: null,
        });
      }
    } else {
      // 'all': cover from earliest tx (capped to last 60 days for readability) through today
      let earliestMs = todayEnd.getTime() - 13 * 86400000;
      for (const tx of filtered) {
        const d = getTxDate(tx);
        if (d && d.getTime() < earliestMs) earliestMs = d.getTime();
      }
      const diffDays = Math.min(
        60,
        Math.max(7, Math.ceil((todayEnd.getTime() - earliestMs) / 86400000) + 1)
      );
      spanDays = diffDays;
      for (let i = diffDays - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        dayBuckets.push({
          key: toDayKey(d),
          label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          delivered: 0,
          sent: 0,
          pending: 0,
          failed: 0,
          total: 0,
          successRate: null,
        });
      }
    }

    const bucketMap = new Map(dayBuckets.map((b) => [b.key, b]));
    for (const tx of filtered) {
      const d = getTxDate(tx);
      if (!d) continue;
      const bucket = bucketMap.get(toDayKey(d));
      if (!bucket) continue;
      bucket.total += 1;
      if (tx.status === 'delivered') bucket.delivered += 1;
      else if (tx.status === 'sent') bucket.sent += 1;
      else if (tx.status === 'pending') bucket.pending += 1;
      else bucket.failed += 1;
    }

    let peakDayVolume = 0;
    let peakDayLabel = '—';
    for (const b of dayBuckets) {
      const completed = b.delivered + b.sent + b.failed;
      b.successRate = completed > 0 ? Math.round(((b.delivered + b.sent) / completed) * 100) : null;
      if (b.total > peakDayVolume) {
        peakDayVolume = b.total;
        peakDayLabel = b.label;
      }
    }

    const avgDailyVolume = spanDays > 0 ? Number((total / spanDays).toFixed(1)) : 0;

    const statusBreakdown = [
      { key: 'delivered', name: 'Delivered', value: delivered, color: STATUS_COLORS.delivered },
      { key: 'sent', name: 'Sent via SIM', value: sent, color: STATUS_COLORS.sent },
      { key: 'pending', name: 'Pending', value: pending, color: STATUS_COLORS.pending },
      { key: 'failed', name: 'Failed / Rejected', value: totalFailed, color: STATUS_COLORS.failed },
    ];

    const failureReasons: FailureReasonPoint[] = Array.from(failureCounts.entries())
      .map(([reason, count]) => ({
        reason,
        count,
        share: totalFailed > 0 ? Math.round((count / totalFailed) * 100) : 0,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      total,
      delivered,
      sent,
      pending,
      totalSuccessful,
      totalFailed,
      successRate,
      failureRate,
      avgDailyVolume,
      peakDayVolume,
      peakDayLabel,
      dayBuckets,
      statusBreakdown,
      failureReasons,
    };
  }, [transactions, range]);

  const xAxisInterval =
    analytics.dayBuckets.length <= 8
      ? 0
      : analytics.dayBuckets.length <= 16
        ? 1
        : Math.max(2, Math.floor(analytics.dayBuckets.length / 7));

  return (
    <section
      className="bg-white border border-slate-200 rounded-2xl overflow-hidden"
      aria-labelledby="sms-analytics-heading"
    >
      {/* Widget Header & Time Range Switcher */}
      <div className="px-5 py-4 sm:px-6 sm:py-5 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="space-y-0.5">
          <h2
            id="sms-analytics-heading"
            className="font-display text-base sm:text-lg font-bold text-slate-900"
          >
            SMS Delivery &amp; Volume Analytics
          </h2>
          <p className="text-xs text-slate-500">
            Delivery success rate · Failure reasons · Daily sending volume
          </p>
        </div>

        <div
          className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-xl self-start sm:self-auto"
          role="group"
          aria-label="Analytics timeframe"
        >
          {RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setRange(opt.value)}
              className={`min-h-[36px] px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                range === opt.value
                  ? 'bg-white text-blue-700 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Key Analytical Strip (Hairline Dividers, Zero Nested Cards) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-slate-200 border-b border-slate-200 bg-slate-50/60">
        <div className="px-5 py-4 space-y-1">
          <p className="text-xs font-medium text-slate-500">Delivery Success Rate</p>
          <p className="font-mono tabular-nums text-2xl font-semibold text-emerald-700">
            {loading ? '—' : `${analytics.successRate}%`}
          </p>
          <p className="text-xs text-slate-500 font-mono tabular-nums">
            {analytics.totalSuccessful.toLocaleString()} of {analytics.total.toLocaleString()} SMS
          </p>
        </div>

        <div className="px-5 py-4 space-y-1">
          <p className="text-xs font-medium text-slate-500">Failure Rate</p>
          <p className="font-mono tabular-nums text-2xl font-semibold text-red-600">
            {loading ? '—' : `${analytics.failureRate}%`}
          </p>
          <p className="text-xs text-slate-500 font-mono tabular-nums">
            {analytics.totalFailed.toLocaleString()} failed · {analytics.pending} pending
          </p>
        </div>

        <div className="px-5 py-4 space-y-1">
          <p className="text-xs font-medium text-slate-500">Daily Avg Volume</p>
          <p className="font-mono tabular-nums text-2xl font-semibold text-slate-900">
            {loading ? '—' : analytics.avgDailyVolume.toLocaleString()}
          </p>
          <p className="text-xs text-slate-500 font-mono tabular-nums">
            Peak: {analytics.peakDayVolume.toLocaleString()} ({analytics.peakDayLabel})
          </p>
        </div>

        <div className="px-5 py-4 space-y-1">
          <p className="text-xs font-medium text-slate-500">Top Failure Reason</p>
          <p className="text-sm font-semibold text-slate-900 truncate pt-1">
            {loading
              ? '—'
              : analytics.failureReasons[0]
                ? analytics.failureReasons[0].reason
                : 'No failures recorded'}
          </p>
          <p className="text-xs text-slate-500 font-mono tabular-nums">
            {analytics.failureReasons[0]
              ? `${analytics.failureReasons[0].count} (${analytics.failureReasons[0].share}% of fails)`
              : 'All dispatched SMS healthy'}
          </p>
        </div>
      </div>

      {loading ? (
        <div className="p-6 space-y-6">
          <div className="h-64 rounded-xl bg-slate-100 animate-pulse" />
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-5 h-56 rounded-xl bg-slate-100 animate-pulse" />
            <div className="lg:col-span-7 h-56 rounded-xl bg-slate-100 animate-pulse" />
          </div>
        </div>
      ) : (
        <>
          {/* Section 1: Daily Sending Volume + Success Rate Overlay (Recharts ComposedChart) */}
          <div className="p-5 sm:p-6 border-b border-slate-200 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h3 className="font-display text-sm font-bold text-slate-900">
                  Daily Sending Volume &amp; Success Rate
                </h3>
                <p className="text-xs text-slate-500">
                  Stacked SMS outcomes per day overlaid with delivery success percentage
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-xs bg-emerald-600" aria-hidden="true" />
                  Delivered
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-xs bg-blue-700" aria-hidden="true" />
                  Sent
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-xs bg-red-600" aria-hidden="true" />
                  Failed
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-3 h-0.5 bg-slate-900" aria-hidden="true" />
                  Success %
                </span>
              </div>
            </div>

            {analytics.total === 0 ? (
              <div className="h-56 flex flex-col items-center justify-center text-center space-y-3 bg-slate-50/70 rounded-xl p-6">
                <p className="text-sm font-semibold text-slate-800">
                  No SMS volume recorded in this timeframe
                </p>
                <p className="text-xs text-slate-500 max-w-sm">
                  Dispatch your first SIM message or campaign to track daily sending volume,
                  delivery rates, and failure diagnostics here.
                </p>
                <button
                  type="button"
                  onClick={() => onNavigate('send')}
                  className="min-h-[40px] px-4 py-2 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold inline-flex items-center gap-2 transition-colors cursor-pointer whitespace-nowrap"
                >
                  <Send className="w-3.5 h-3.5" />
                  Send First SMS
                </button>
              </div>
            ) : (
              <div className="h-64 sm:h-72 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart
                    data={analytics.dayBuckets}
                    margin={{ top: 8, right: 8, left: -16, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} />
                    <XAxis
                      dataKey="label"
                      interval={xAxisInterval}
                      tick={{ fontSize: 11, fill: '#64748B' }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      yAxisId="volume"
                      allowDecimals={false}
                      tick={{ fontSize: 11, fill: '#64748B' }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      yAxisId="rate"
                      orientation="right"
                      domain={[0, 100]}
                      tickFormatter={(v: number) => `${v}%`}
                      tick={{ fontSize: 11, fill: '#64748B' }}
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
                      formatter={(value, name) => {
                        if (name === 'Success Rate') {
                          return [value === null || value === undefined ? '—' : `${value}%`, name];
                        }
                        return [Number(value || 0).toLocaleString(), name];
                      }}
                    />
                    <Bar
                      yAxisId="volume"
                      dataKey="delivered"
                      name="Delivered"
                      stackId="sms"
                      fill={STATUS_COLORS.delivered}
                      maxBarSize={32}
                    />
                    <Bar
                      yAxisId="volume"
                      dataKey="sent"
                      name="Sent via SIM"
                      stackId="sms"
                      fill={STATUS_COLORS.sent}
                      maxBarSize={32}
                    />
                    <Bar
                      yAxisId="volume"
                      dataKey="pending"
                      name="Pending"
                      stackId="sms"
                      fill={STATUS_COLORS.pending}
                      maxBarSize={32}
                    />
                    <Bar
                      yAxisId="volume"
                      dataKey="failed"
                      name="Failed"
                      stackId="sms"
                      fill={STATUS_COLORS.failed}
                      radius={[4, 4, 0, 0]}
                      maxBarSize={32}
                    />
                    <Line
                      yAxisId="rate"
                      type="monotone"
                      dataKey="successRate"
                      name="Success Rate"
                      stroke="#0F172A"
                      strokeWidth={2}
                      connectNulls
                      dot={{ r: 3, fill: '#0F172A' }}
                      activeDot={{ r: 5 }}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {/* Section 2: Split Breakdown — Delivery Outcome Donut + Failure Reasons BarChart */}
          <div className="grid grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-slate-200">
            {/* Delivery Success Rate Donut */}
            <div className="lg:col-span-5 p-5 sm:p-6 space-y-4">
              <div>
                <h3 className="font-display text-sm font-bold text-slate-900">
                  Delivery Outcome Share
                </h3>
                <p className="text-xs text-slate-500">
                  Proportional status mix across all dispatches
                </p>
              </div>

              {analytics.total === 0 ? (
                <div className="h-52 flex items-center justify-center text-xs text-slate-500 bg-slate-50/70 rounded-xl">
                  Send messages to populate delivery share.
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
                  <div className="relative h-48 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={analytics.statusBreakdown.filter((s) => s.value > 0)}
                          dataKey="value"
                          nameKey="name"
                          cx="50%"
                          cy="50%"
                          innerRadius={54}
                          outerRadius={78}
                          paddingAngle={2}
                          stroke="none"
                        >
                          {analytics.statusBreakdown
                            .filter((s) => s.value > 0)
                            .map((entry) => (
                              <Cell key={entry.key} fill={entry.color} />
                            ))}
                        </Pie>
                        <Tooltip
                          contentStyle={{
                            backgroundColor: '#0F172A',
                            border: 'none',
                            borderRadius: '10px',
                            color: '#FFFFFF',
                            fontSize: '12px',
                          }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                      <span className="font-mono tabular-nums text-xl font-bold text-slate-900">
                        {analytics.successRate}%
                      </span>
                      <span className="text-[11px] text-slate-500">Success</span>
                    </div>
                  </div>

                  <dl className="divide-y divide-slate-100 text-xs">
                    {analytics.statusBreakdown.map((item) => {
                      const pct =
                        analytics.total > 0 ? Math.round((item.value / analytics.total) * 100) : 0;
                      return (
                        <div
                          key={item.key}
                          className="py-2 flex items-center justify-between gap-2"
                        >
                          <dt className="flex items-center gap-2 text-slate-700 min-w-0">
                            <span
                              className="w-2.5 h-2.5 rounded-xs shrink-0"
                              style={{ backgroundColor: item.color }}
                              aria-hidden="true"
                            />
                            <span className="truncate">{item.name}</span>
                          </dt>
                          <dd className="font-mono tabular-nums text-slate-900 font-semibold whitespace-nowrap shrink-0">
                            {item.value.toLocaleString()}{' '}
                            <span className="text-slate-400 font-normal">({pct}%)</span>
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                </div>
              )}
            </div>

            {/* Failure Reasons Horizontal Bar Chart */}
            <div className="lg:col-span-7 p-5 sm:p-6 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h3 className="font-display text-sm font-bold text-slate-900">
                    Failure Reasons Diagnostic
                  </h3>
                  <p className="text-xs text-slate-500">
                    Grouped causes of failed or rejected SIM dispatches
                  </p>
                </div>
                {analytics.totalFailed > 0 && (
                  <button
                    type="button"
                    onClick={() => onNavigate('history')}
                    className="text-xs font-semibold text-blue-700 hover:text-blue-800 cursor-pointer whitespace-nowrap shrink-0"
                  >
                    Inspect Logs
                  </button>
                )}
              </div>

              {analytics.failureReasons.length === 0 ? (
                <div className="h-52 flex flex-col items-center justify-center text-center bg-slate-50/70 rounded-xl p-6 space-y-1.5">
                  <p className="text-sm font-semibold text-emerald-700">
                    {analytics.total > 0 ? 'Zero failed SMS in this timeframe' : 'No failure data yet'}
                  </p>
                  <p className="text-xs text-slate-500 max-w-xs">
                    {analytics.total > 0
                      ? 'Every dispatched SMS succeeded without SIM timeouts, offline handsets, or carrier rejections.'
                      : 'Any SIM timeout, offline device, or carrier rejection will be categorized here automatically.'}
                  </p>
                </div>
              ) : (
                <div className="h-52 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={analytics.failureReasons}
                      layout="vertical"
                      margin={{ top: 4, right: 20, left: 8, bottom: 4 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" horizontal={false} />
                      <XAxis
                        type="number"
                        allowDecimals={false}
                        tick={{ fontSize: 11, fill: '#64748B' }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis
                        type="category"
                        dataKey="reason"
                        width={165}
                        tick={{ fontSize: 11, fill: '#334155' }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#0F172A',
                          border: 'none',
                          borderRadius: '10px',
                          color: '#FFFFFF',
                          fontSize: '12px',
                        }}
                        formatter={(value, _name, item) => {
                          const share = (item?.payload as FailureReasonPoint | undefined)?.share ?? 0;
                          return [`${Number(value || 0).toLocaleString()} (${share}%)`, 'Failures'];
                        }}
                      />
                      <Bar dataKey="count" radius={[0, 6, 6, 0]} maxBarSize={24}>
                        {analytics.failureReasons.map((entry, idx) => (
                          <Cell
                            key={entry.reason}
                            fill={FAILURE_BAR_COLORS[idx % FAILURE_BAR_COLORS.length]}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
