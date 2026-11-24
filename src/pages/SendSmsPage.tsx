import React, { useMemo, useRef, useState } from 'react';
import {
  Send,
  Upload,
  CalendarClock,
  Calculator,
  CheckCircle2,
  AlertCircle,
  Eye,
  X,
  ChevronLeft,
  ChevronRight,
  Trash2,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { usePortalData } from '../context/PortalDataContext';
import { estimateSmsCost } from '../lib/api';
import {
  analyzeSmsMessage,
  isValidE164Phone,
  normalizePhoneNumber,
  parseContactsSpreadsheet,
  renderPersonalizedMessage,
} from '../lib/smsUtils';
import type { PortalTab, RecipientItem } from '../types/portal';

export function SendSmsPage({ onNavigate }: { onNavigate: (tab: PortalTab) => void }) {
  const { permissions } = useAuth();
  const {
    groups,
    contacts,
    gatewayConfig,
    executeBulkCampaign,
    activeDispatch,
  } = usePortalData();

  const [campaignName, setCampaignName] = useState('');
  const [senderId, setSenderId] = useState(gatewayConfig?.senderId || 'ZACMA');
  const [manualInput, setManualInput] = useState('');
  const [defaultEthiopia, setDefaultEthiopia] = useState(true);
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [uploadedRecipients, setUploadedRecipients] = useState<RecipientItem[]>([]);
  const [uploadStats, setUploadStats] = useState<string | null>(null);
  const [messageTemplate, setMessageTemplate] = useState('');
  const [sendMode, setSendMode] = useState<'now' | 'schedule'>('now');
  const [scheduledAt, setScheduledAt] = useState('');

  const [previewIdx, setPreviewIdx] = useState(0);
  const [estimating, setEstimating] = useState(false);
  const [estimateResult, setEstimateResult] = useState<{
    cost: number | null;
    currency: string;
    note: string;
  } | null>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Parse manual numbers
  const manualParsed = useMemo(() => {
    const tokens = manualInput
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    const valid: RecipientItem[] = [];
    const invalid: string[] = [];

    for (const raw of tokens) {
      const normalized = normalizePhoneNumber(raw, defaultEthiopia);
      if (isValidE164Phone(normalized)) {
        valid.push({ phone: normalized, name: 'Customer', source: 'manual' });
      } else {
        invalid.push(raw);
      }
    }
    return { valid, invalid };
  }, [manualInput, defaultEthiopia]);

  // Combine & deduplicate all recipients across Manual + Groups + Uploaded file
  const combinedRecipients = useMemo(() => {
    const map = new Map<string, RecipientItem>();

    // Group contacts first (richer names)
    if (selectedGroupIds.length > 0) {
      for (const c of contacts) {
        if (selectedGroupIds.some((gid) => c.groupIds.includes(gid))) {
          if (!map.has(c.phone)) {
            map.set(c.phone, { phone: c.phone, name: c.name, source: 'group' });
          }
        }
      }
    }

    // Uploaded Excel/CSV contacts
    for (const u of uploadedRecipients) {
      if (!map.has(u.phone)) {
        map.set(u.phone, u);
      }
    }

    // Manual phone numbers
    for (const m of manualParsed.valid) {
      if (!map.has(m.phone)) {
        map.set(m.phone, m);
      }
    }

    return Array.from(map.values());
  }, [contacts, selectedGroupIds, uploadedRecipients, manualParsed.valid]);

  const msgMetrics = useMemo(() => analyzeSmsMessage(messageTemplate), [messageTemplate]);

  const totalEstimatedSegments = useMemo(() => {
    if (combinedRecipients.length === 0 || !messageTemplate.trim()) return 0;
    return combinedRecipients.reduce((sum, r) => {
      const rendered = renderPersonalizedMessage(messageTemplate, r);
      return sum + Math.max(1, analyzeSmsMessage(rendered).segments);
    }, 0);
  }, [combinedRecipients, messageTemplate]);

  const currentPreviewRecipient =
    combinedRecipients[Math.min(previewIdx, Math.max(0, combinedRecipients.length - 1))] || {
      name: 'Abebe Kebede',
      phone: '+251911223344',
      source: 'manual' as const,
    };

  const previewText = useMemo(
    () => renderPersonalizedMessage(messageTemplate, currentPreviewRecipient),
    [messageTemplate, currentPreviewRecipient]
  );

  const toggleGroup = (id: string) => {
    setSelectedGroupIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const insertPlaceholder = (token: string) => {
    setMessageTemplate((prev) => `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}${token}`);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFeedback(null);
    try {
      const rows = await parseContactsSpreadsheet(file, defaultEthiopia);
      const validRows = rows.filter((r) => r.valid);
      const invalidCount = rows.length - validRows.length;
      const dedup = new Map<string, RecipientItem>();
      for (const r of validRows) {
        if (!dedup.has(r.phone)) {
          dedup.set(r.phone, { phone: r.phone, name: r.name, source: 'file' });
        }
      }
      const list = Array.from(dedup.values());
      setUploadedRecipients(list);
      setUploadStats(
        `${file.name}: ${list.length} valid unique numbers loaded${
          invalidCount > 0 ? ` (${invalidCount} invalid skipped)` : ''
        }`
      );
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to parse uploaded file.',
      });
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleEstimateCost = async () => {
    setFeedback(null);
    if (combinedRecipients.length === 0 || !messageTemplate.trim()) {
      setFeedback({
        type: 'error',
        text: 'Add at least one valid recipient and write a message to estimate cost.',
      });
      return;
    }

    setEstimating(true);
    try {
      const res = await estimateSmsCost({
        to: combinedRecipients.map((r) => r.phone),
        message: renderPersonalizedMessage(messageTemplate, combinedRecipients[0]),
        senderId: senderId.trim() || 'ZACMA',
      });
      if (res.estimatedCost !== null) {
        setEstimateResult({
          cost: res.estimatedCost,
          currency: res.currency || 'USD',
          note: `Live SMS.io estimate for ${combinedRecipients.length} recipients (${res.estimatedSegments} segments)`,
        });
      } else {
        setEstimateResult({
          cost: null,
          currency: res.currency || 'USD',
          note: res.error || 'SMS.io did not return a numeric cost estimate.',
        });
      }
    } catch (err) {
      setEstimateResult({
        cost: null,
        currency: 'USD',
        note: err instanceof Error ? err.message : 'Cost estimate failed.',
      });
    } finally {
      setEstimating(false);
    }
  };

  const handleOpenConfirmation = (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);

    if (!permissions.canSendBulk) {
      setFeedback({ type: 'error', text: 'Your staff account does not have permission to send bulk SMS.' });
      return;
    }
    if (combinedRecipients.length === 0) {
      setFeedback({
        type: 'error',
        text: 'Add at least one valid Ethiopian (+251) or international phone number.',
      });
      return;
    }
    if (!messageTemplate.trim()) {
      setFeedback({ type: 'error', text: 'Please enter an SMS message.' });
      return;
    }
    if (messageTemplate.trim().length > 1600) {
      setFeedback({ type: 'error', text: 'Message exceeds the 1,600 character safety limit.' });
      return;
    }
    if (sendMode === 'schedule' && !scheduledAt) {
      setFeedback({ type: 'error', text: 'Select a date and time for the scheduled campaign.' });
      return;
    }
    if (sendMode === 'schedule' && selectedGroupIds.length === 0) {
      setFeedback({
        type: 'error',
        text: 'Select at least one saved contact group when scheduling a campaign so recipients are preserved.',
      });
      return;
    }

    setConfirmOpen(true);
  };

  const handleConfirmExecute = async () => {
    setSubmitting(true);
    setConfirmOpen(false);
    setFeedback(null);

    const finalName =
      campaignName.trim() ||
      `Bulk SMS ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;

    try {
      await executeBulkCampaign({
        name: finalName,
        messageTemplate: messageTemplate.trim(),
        senderId: senderId.trim() || 'ZACMA',
        groupIds: selectedGroupIds,
        recipients: combinedRecipients,
        scheduledAt: sendMode === 'schedule' ? scheduledAt : undefined,
        estimatedCost: estimateResult?.cost ?? 0,
        currency: estimateResult?.currency || 'USD',
      });

      setFeedback({
        type: 'success',
        text:
          sendMode === 'schedule'
            ? `Campaign "${finalName}" scheduled successfully.`
            : `Campaign "${finalName}" finished processing. View full delivery logs in SMS History.`,
      });
      setCampaignName('');
      setManualInput('');
      setUploadedRecipients([]);
      setUploadStats(null);
      setMessageTemplate('');
      setEstimateResult(null);
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to execute bulk campaign.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {!permissions.canSendBulk && (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-sm text-red-700">
          Your role currently has view-only access and cannot send bulk SMS campaigns. Contact a
          ZACMA Technology administrator to enable bulk sending.
        </div>
      )}

      {feedback && (
        <div
          className={`rounded-2xl p-4 border flex items-start justify-between gap-3 text-sm ${
            feedback.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-red-50 border-red-200 text-red-700'
          }`}
        >
          <div className="flex items-start gap-2.5">
            {feedback.type === 'success' ? (
              <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5" />
            ) : (
              <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
            )}
            <div className="space-y-1">
              <p>{feedback.text}</p>
              {feedback.type === 'success' && (
                <button
                  type="button"
                  onClick={() => onNavigate('history')}
                  className="text-xs font-semibold underline cursor-pointer"
                >
                  Open SMS History & Delivery Reports
                </button>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="p-1 rounded-lg hover:bg-black/5 cursor-pointer"
            aria-label="Dismiss notification"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <form onSubmit={handleOpenConfirmation} className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Recipients & Message Composition */}
        <div className="lg:col-span-7 space-y-6">
          {/* Campaign Details */}
          <div className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-4">
            <h2 className="font-display text-base font-bold text-slate-900">1. Campaign Details</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="sm:col-span-2 space-y-1.5">
                <label htmlFor="camp-name" className="block text-xs font-semibold text-slate-700">
                  Campaign Name
                </label>
                <input
                  id="camp-name"
                  type="text"
                  maxLength={140}
                  value={campaignName}
                  onChange={(e) => setCampaignName(e.target.value)}
                  placeholder="e.g. Monthly Invoice Reminder — Addis Ababa"
                  className="w-full min-h-[44px] px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600"
                />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="sender-id" className="block text-xs font-semibold text-slate-700">
                  Sender ID
                </label>
                <input
                  id="sender-id"
                  type="text"
                  maxLength={11}
                  value={senderId}
                  onChange={(e) => setSenderId(e.target.value)}
                  placeholder="ZACMA"
                  className="w-full min-h-[44px] px-3.5 py-2.5 rounded-xl border border-slate-300 font-mono text-sm text-slate-900 focus:border-blue-600"
                />
              </div>
            </div>
          </div>

          {/* Recipients Selection */}
          <div className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <h2 className="font-display text-base font-bold text-slate-900">
                2. Recipients ({combinedRecipients.length} unique)
              </h2>
              <label className="inline-flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={defaultEthiopia}
                  onChange={(e) => setDefaultEthiopia(e.target.checked)}
                  className="w-4 h-4 rounded accent-blue-700"
                />
                <span>Auto-format Ethiopian local numbers (09/07 → +251)</span>
              </label>
            </div>

            {/* Saved Contact Groups */}
            <div className="space-y-2">
              <p className="text-xs font-semibold text-slate-700">Select Saved Contact Groups</p>
              {groups.length === 0 ? (
                <p className="text-xs text-slate-500">
                  No contact groups created yet.{' '}
                  <button
                    type="button"
                    onClick={() => onNavigate('contacts')}
                    className="text-blue-700 font-semibold underline cursor-pointer"
                  >
                    Create groups in Contacts
                  </button>
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {groups.map((g) => {
                    const count = contacts.filter((c) => c.groupIds.includes(g.id)).length;
                    const selected = selectedGroupIds.includes(g.id);
                    return (
                      <button
                        key={g.id}
                        type="button"
                        onClick={() => toggleGroup(g.id)}
                        className={`min-h-[40px] px-3.5 py-2 rounded-xl border text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                          selected
                            ? 'bg-blue-700 border-blue-700 text-white'
                            : 'bg-slate-50 border-slate-200 text-slate-700 hover:border-blue-400'
                        }`}
                      >
                        {g.name} ({count})
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Manual Numbers */}
            <div className="space-y-1.5">
              <label htmlFor="manual-numbers" className="block text-xs font-semibold text-slate-700">
                Enter One or Multiple Phone Numbers (comma or new line separated)
              </label>
              <textarea
                id="manual-numbers"
                rows={3}
                value={manualInput}
                onChange={(e) => setManualInput(e.target.value)}
                placeholder="+251911223344, 0912345678, +251711223344, +14155550199"
                className="w-full p-3.5 rounded-xl border border-slate-300 font-mono text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600"
              />
              {manualParsed.invalid.length > 0 && (
                <p className="text-xs text-red-600">
                  Invalid format ({manualParsed.invalid.length}): {manualParsed.invalid.slice(0, 4).join(', ')}
                </p>
              )}
            </div>

            {/* Quick Excel / CSV Upload */}
            <div className="pt-2 border-t border-slate-100 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-semibold text-slate-700">Or Upload Excel (.xlsx/.xls) / CSV File</p>
                {uploadedRecipients.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setUploadedRecipients([]);
                      setUploadStats(null);
                    }}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-red-600 hover:text-red-700 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Clear file
                  </button>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={(e) => void handleFileUpload(e)}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-full min-h-[48px] border border-dashed border-slate-300 hover:border-blue-600 hover:bg-blue-50/40 rounded-xl px-4 py-3 flex items-center justify-center gap-2 text-xs sm:text-sm font-semibold text-slate-700 transition-colors cursor-pointer"
              >
                <Upload className="w-4 h-4 text-blue-700" />
                <span>Upload Excel or CSV Contact File</span>
              </button>
              {uploadStats && <p className="text-xs text-blue-700 font-medium">{uploadStats}</p>}
            </div>
          </div>

          {/* Message Composition */}
          <div className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-base font-bold text-slate-900">3. Write SMS Message</h2>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-slate-500">Insert:</span>
                {['{name}', '{first_name}', '{phone}'].map((tok) => (
                  <button
                    key={tok}
                    type="button"
                    onClick={() => insertPlaceholder(tok)}
                    className="min-h-[32px] px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-blue-100 text-slate-800 hover:text-blue-800 font-mono text-xs font-medium cursor-pointer transition-colors"
                  >
                    {tok}
                  </button>
                ))}
              </div>
            </div>

            <textarea
              rows={5}
              maxLength={1600}
              value={messageTemplate}
              onChange={(e) => setMessageTemplate(e.target.value)}
              placeholder="Dear {name}, thank you for choosing ZACMA Technology. Your service update is ready..."
              className="w-full p-3.5 rounded-xl border border-slate-300 text-sm text-slate-900 placeholder:text-slate-400 leading-relaxed focus:border-blue-600"
            />

            <div className="flex flex-wrap items-center justify-between gap-3 text-xs font-mono tabular-nums text-slate-600 pt-1">
              <div className="flex flex-wrap items-center gap-3">
                <span>
                  <strong className="text-slate-900">{msgMetrics.charCount}</strong> chars
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  <strong className="text-blue-700">{msgMetrics.segments}</strong>{' '}
                  {msgMetrics.segments === 1 ? 'segment' : 'segments'}/SMS
                </span>
                <span aria-hidden="true">·</span>
                <span>{msgMetrics.encoding}</span>
              </div>
              <span className="text-slate-500">
                {msgMetrics.remainingInSegment} left in current segment
              </span>
            </div>

            {/* Schedule Toggle */}
            <div className="pt-4 border-t border-slate-100 space-y-3">
              <div className="grid grid-cols-2 gap-2 p-1 bg-slate-100 rounded-xl">
                <button
                  type="button"
                  onClick={() => setSendMode('now')}
                  className={`min-h-[42px] rounded-lg text-xs sm:text-sm font-semibold transition-colors cursor-pointer ${
                    sendMode === 'now'
                      ? 'bg-white text-blue-700 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Send Immediately
                </button>
                <button
                  type="button"
                  onClick={() => setSendMode('schedule')}
                  className={`min-h-[42px] rounded-lg text-xs sm:text-sm font-semibold transition-colors cursor-pointer ${
                    sendMode === 'schedule'
                      ? 'bg-white text-blue-700 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Schedule Campaign
                </button>
              </div>

              {sendMode === 'schedule' && (
                <div className="space-y-1.5">
                  <label htmlFor="schedule-dt" className="block text-xs font-semibold text-slate-700">
                    Scheduled Dispatch Date & Time
                  </label>
                  <input
                    id="schedule-dt"
                    type="datetime-local"
                    value={scheduledAt}
                    onChange={(e) => setScheduledAt(e.target.value)}
                    className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-300 text-sm text-slate-900 focus:border-blue-600"
                  />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right Column: Live Preview, Cost Estimate & Action CTA */}
        <div className="lg:col-span-5 space-y-5 lg:sticky lg:top-20">
          {/* Live Handset Preview */}
          <div className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Eye className="w-4 h-4 text-blue-700" />
                <h3 className="font-display text-sm font-bold text-slate-900">Message Preview</h3>
              </div>
              {combinedRecipients.length > 1 && (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() =>
                      setPreviewIdx((i) => (i <= 0 ? combinedRecipients.length - 1 : i - 1))
                    }
                    className="min-h-[32px] min-w-[32px] flex items-center justify-center rounded-lg hover:bg-slate-100 text-slate-600 cursor-pointer"
                    aria-label="Previous recipient preview"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <span className="text-xs font-mono tabular-nums text-slate-500">
                    {Math.min(previewIdx + 1, combinedRecipients.length)}/{combinedRecipients.length}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setPreviewIdx((i) => (i + 1 >= combinedRecipients.length ? 0 : i + 1))
                    }
                    className="min-h-[32px] min-w-[32px] flex items-center justify-center rounded-lg hover:bg-slate-100 text-slate-600 cursor-pointer"
                    aria-label="Next recipient preview"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              )}
            </div>

            <div className="bg-slate-950 rounded-2xl p-4 space-y-3 text-white">
              <div className="flex items-center justify-between text-xs border-b border-slate-800 pb-2.5">
                <span className="font-mono font-semibold text-blue-300">{senderId || 'ZACMA'}</span>
                <span className="font-mono text-slate-400">{currentPreviewRecipient.phone}</span>
              </div>
              <div className="bg-slate-800/90 rounded-xl p-3.5 text-sm text-slate-100 whitespace-pre-wrap break-words min-h-[84px] leading-relaxed">
                {previewText || (
                  <span className="text-slate-400">
                    Your personalized SMS preview will appear here...
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-400">
                Recipient: {currentPreviewRecipient.name}
              </p>
            </div>
          </div>

          {/* Summary & Cost Estimator */}
          <div className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-4">
            <h3 className="font-display text-sm font-bold text-slate-900">Campaign Summary</h3>

            <dl className="space-y-2.5 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-500">Unique Recipients</dt>
                <dd className="font-mono tabular-nums font-semibold text-slate-900">
                  {combinedRecipients.length.toLocaleString()}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Estimated Total Segments</dt>
                <dd className="font-mono tabular-nums font-semibold text-slate-900">
                  {totalEstimatedSegments.toLocaleString()}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Encoding</dt>
                <dd className="font-mono font-medium text-slate-800">{msgMetrics.encoding}</dd>
              </div>
              {estimateResult && (
                <div className="flex justify-between pt-2 border-t border-slate-100">
                  <dt className="text-slate-600 font-medium">SMS.io Est. Cost</dt>
                  <dd className="font-mono tabular-nums font-bold text-blue-700">
                    {estimateResult.cost !== null
                      ? `${estimateResult.currency} ${estimateResult.cost.toFixed(4)}`
                      : 'Unavailable'}
                  </dd>
                </div>
              )}
            </dl>

            {estimateResult?.note && (
              <p className="text-xs text-slate-500 leading-relaxed">{estimateResult.note}</p>
            )}

            <button
              type="button"
              onClick={() => void handleEstimateCost()}
              disabled={estimating || combinedRecipients.length === 0 || !messageTemplate.trim()}
              className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 hover:bg-slate-50 text-slate-800 text-xs sm:text-sm font-semibold px-4 transition-colors cursor-pointer disabled:opacity-50"
            >
              <Calculator className="w-4 h-4 text-blue-700" />
              {estimating ? 'Calculating via SMS.io...' : 'Estimate SMS Cost'}
            </button>

            <button
              type="submit"
              disabled={
                submitting ||
                Boolean(activeDispatch?.running) ||
                !permissions.canSendBulk ||
                combinedRecipients.length === 0 ||
                !messageTemplate.trim()
              }
              className="w-full min-h-[50px] inline-flex items-center justify-center gap-2 rounded-xl bg-blue-700 hover:bg-blue-800 active:scale-[0.99] text-white text-sm font-semibold px-5 transition-all cursor-pointer disabled:opacity-50"
            >
              {sendMode === 'schedule' ? (
                <>
                  <CalendarClock className="w-4 h-4" />
                  <span>Review & Schedule Campaign</span>
                </>
              ) : (
                <>
                  <Send className="w-4 h-4" />
                  <span>Review & Send Bulk SMS</span>
                </>
              )}
            </button>
          </div>
        </div>
      </form>

      {/* Mandatory Campaign Confirmation Modal */}
      {confirmOpen && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setConfirmOpen(false)}
        >
          <div
            className="w-full sm:max-w-lg bg-white rounded-t-3xl sm:rounded-2xl p-6 space-y-5 border border-slate-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-display text-lg font-bold text-slate-900">
                  Confirm Bulk SMS Execution
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Verify all campaign parameters before dispatching through SMS.io.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl hover:bg-slate-100 text-slate-500 cursor-pointer"
                aria-label="Close confirmation dialog"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-500">Campaign</span>
                <span className="font-semibold text-slate-900">{campaignName.trim() || 'Bulk SMS Dispatch'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Sender ID</span>
                <span className="font-mono font-semibold text-slate-900">{senderId || 'ZACMA'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Recipients</span>
                <span className="font-mono font-semibold text-blue-700">
                  {combinedRecipients.length.toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Total Segments</span>
                <span className="font-mono font-semibold text-slate-900">
                  {totalEstimatedSegments.toLocaleString()}
                </span>
              </div>
              {sendMode === 'schedule' && (
                <div className="flex justify-between">
                  <span className="text-slate-500">Scheduled For</span>
                  <span className="font-mono font-semibold text-slate-900">{scheduledAt}</span>
                </div>
              )}
              <div className="pt-2 border-t border-slate-200">
                <p className="text-slate-500 mb-1">Sample Message Preview:</p>
                <p className="text-slate-800 whitespace-pre-wrap break-words font-medium">
                  {previewText}
                </p>
              </div>
            </div>

            <div className="flex flex-col-reverse sm:flex-row gap-3">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="flex-1 min-h-[46px] rounded-xl border border-slate-300 hover:bg-slate-50 text-slate-700 text-sm font-semibold cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmExecute()}
                className="flex-1 min-h-[46px] rounded-xl bg-red-600 hover:bg-red-700 text-white text-sm font-semibold cursor-pointer"
              >
                {sendMode === 'schedule' ? 'Confirm Schedule' : 'Confirm & Send Now'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
