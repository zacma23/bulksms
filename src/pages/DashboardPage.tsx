import { useMemo } from 'react';
import {
  RefreshCw,
  Send,
  Users,
  Smartphone,
  ArrowRight,
} from 'lucide-react';
import { usePortalData } from '../context/PortalDataContext';
import { ConnectMobileDevice } from '../components/ConnectMobileDevice';
import { SmsAnalyticsWidget } from '../components/SmsAnalyticsWidget';
import { formatTimestamp } from '../lib/smsUtils';
import type { PortalTab } from '../types/portal';

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

      {/* SMS Delivery Success Rates, Failure Reasons & Daily Volume (Recharts) */}
      <SmsAnalyticsWidget
        transactions={transactions}
        loading={dataLoading}
        onNavigate={onNavigate}
      />

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
