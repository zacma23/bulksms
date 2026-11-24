import { useMemo, useState } from 'react';
import { RefreshCw, Search, ShieldCheck, Server } from 'lucide-react';
import { usePortalData } from '../context/PortalDataContext';
import { formatTimestamp } from '../lib/smsUtils';

export function AuditGatewayPage() {
  const { auditLogs, gatewayConfig, gatewayBalance, balanceLoading, refreshGatewayInfo } =
    usePortalData();
  const [searchQuery, setSearchQuery] = useState('');

  const filteredLogs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return auditLogs;
    return auditLogs.filter(
      (l) =>
        l.action.toLowerCase().includes(q) ||
        l.actorEmail.toLowerCase().includes(q) ||
        l.summary.toLowerCase().includes(q) ||
        l.targetType.toLowerCase().includes(q)
    );
  }, [auditLogs, searchQuery]);

  return (
    <div className="space-y-6">
      {/* SMS.io Server-Side Gateway Diagnostics */}
      <section className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-700 flex items-center justify-center shrink-0">
              <Server className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-display text-base font-bold text-slate-900">
                SMS.io Server Gateway Configuration
              </h2>
              <p className="text-xs text-slate-500">
                API credentials are stored exclusively in server environment variables
              </p>
            </div>
          </div>

          <button
            type="button"
            disabled={balanceLoading}
            onClick={() => void refreshGatewayInfo()}
            className="min-h-[42px] inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 hover:bg-slate-50 text-xs font-semibold text-slate-800 px-4 cursor-pointer disabled:opacity-50 whitespace-nowrap"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${balanceLoading ? 'animate-spin' : ''}`} />
            Test Gateway & Balance
          </button>
        </div>

        <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 pt-2 border-t border-slate-100 text-xs">
          <div>
            <dt className="text-slate-500">SMS_IO_API_KEY</dt>
            <dd
              className={`font-semibold mt-1 ${
                gatewayConfig?.configured ? 'text-emerald-700' : 'text-red-600'
              }`}
            >
              {gatewayConfig?.configured ? 'Configured on Server' : 'Not Configured'}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Default Sender ID</dt>
            <dd className="font-mono font-semibold text-slate-900 mt-1">
              {gatewayConfig?.senderId || 'ZACMA'}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">SMS API Endpoint</dt>
            <dd className="font-mono text-slate-800 mt-1 break-all">
              {gatewayConfig?.apiBaseUrl || 'https://api.sms.to'}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Live Account Balance</dt>
            <dd className="font-mono font-semibold text-slate-900 mt-1">
              {gatewayBalance?.balance !== null && gatewayBalance?.balance !== undefined
                ? `${gatewayBalance.currency} ${gatewayBalance.balance.toFixed(2)}`
                : gatewayBalance?.error || 'Unavailable'}
            </dd>
          </div>
        </dl>

        <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-xs text-slate-600 space-y-1.5">
          <div className="flex items-center gap-2 font-semibold text-slate-800">
            <ShieldCheck className="w-4 h-4 text-blue-700" />
            <span>Official SMS.io / SMS.to Server Routes in Use</span>
          </div>
          <p className="font-mono text-[11px] text-slate-600">
            Send: POST /sms/send · Estimate: POST /sms/estimate · Balance: GET /api/balance ·
            Status: GET /message/:id & GET /v2/messages · DLR Webhook: POST /api/sms/webhook
          </p>
        </div>
      </section>

      {/* Immutable Audit Log */}
      <section className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-base font-bold text-slate-900">
              Immutable Security & Activity Audit Log
            </h2>
            <p className="text-xs text-slate-500">
              Append-only log of sign-ins, bulk SMS dispatches, retries, imports, and RBAC changes
            </p>
          </div>

          <div className="relative sm:w-72">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter audit log..."
              className="w-full min-h-[40px] pl-9 pr-3 py-1.5 rounded-xl border border-slate-300 text-xs sm:text-sm"
            />
          </div>
        </div>

        {filteredLogs.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500">
            No audit events recorded yet.
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {filteredLogs.map((log) => (
              <div
                key={log.id}
                className="px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
              >
                <div className="space-y-0.5 min-w-0">
                  <p className="font-semibold text-slate-900">{log.summary}</p>
                  <p className="text-slate-500">
                    <span className="font-mono text-blue-700">{log.action}</span> · {log.actorEmail}{' '}
                    ({log.actorRole}) · {log.targetType}
                  </p>
                </div>
                <span className="font-mono tabular-nums text-slate-500 whitespace-nowrap shrink-0">
                  {formatTimestamp(log.createdAt)}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
