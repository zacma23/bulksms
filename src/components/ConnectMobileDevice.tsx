import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronUp,
  Code2,
  Copy,
  Download,
  Link2,
  RefreshCw,
  Send,
  Smartphone,
  Trash2,
} from 'lucide-react';
import {
  createMobilePairingSession,
  disconnectLinkedDevice,
  fetchAndroidCompanionPackage,
  fetchMobileDeviceStatus,
  sendMobileDeviceTestSms,
  updateLinkedDeviceSimSlot,
} from '../lib/api';
import { subscribeFirestoreMobileDevices } from '../lib/firestoreSimBridge';
import { useAuth } from '../context/AuthContext';
import { usePortalData } from '../context/PortalDataContext';
import { isValidE164Phone, normalizePhoneNumber } from '../lib/smsUtils';
import { AndroidSetupGuideModal } from './AndroidSetupGuideModal';
import type {
  LinkedMobileDevice,
  MobilePairingSession,
  SimSlotPreference,
} from '../types/portal';

const SIM_OPTIONS: { value: SimSlotPreference; label: string }[] = [
  { value: 'auto', label: 'Auto SIM' },
  { value: 'sim1', label: 'SIM 1' },
  { value: 'sim2', label: 'SIM 2' },
];

type SocketState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

function formatCountdown(
  expiresAtIso: string | undefined,
  nowMs: number
): { text: string; expired: boolean } {
  if (!expiresAtIso) return { text: '00:00', expired: true };
  const diffSec = Math.max(0, Math.floor((new Date(expiresAtIso).getTime() - nowMs) / 1000));
  if (diffSec <= 0) return { text: 'Expired', expired: true };
  const mins = Math.floor(diffSec / 60);
  const secs = diffSec % 60;
  return {
    text: `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`,
    expired: false,
  };
}

function formatRelativeTime(iso: string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return 'Just now';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return 'Just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function buildWebSocketUrl(origin: string, wsEndpoint: string): string {
  try {
    const parsed = new URL(origin);
    const proto = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${parsed.host}${wsEndpoint}`;
  } catch {
    return wsEndpoint;
  }
}

function upsertDevice(list: LinkedMobileDevice[], next: LinkedMobileDevice): LinkedMobileDevice[] {
  const idx = list.findIndex((d) => d.id === next.id);
  if (idx === -1) return [next, ...list];
  const copy = [...list];
  copy[idx] = next;
  return copy;
}

export function ConnectMobileDevice() {
  const { authorized, firebaseUser } = useAuth();
  const { refreshSimBridgeStatus } = usePortalData();

  const [simSlot, setSimSlot] = useState<SimSlotPreference>('auto');
  const [session, setSession] = useState<MobilePairingSession | null>(null);
  const [devices, setDevices] = useState<LinkedMobileDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshingQr, setRefreshingQr] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [socketState, setSocketState] = useState<SocketState>('disconnected');
  const [error, setError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<'pin' | 'link' | 'payload' | 'kotlin' | null>(null);
  const [downloadingCompanion, setDownloadingCompanion] = useState(false);
  const [showTechnicalGuide, setShowTechnicalGuide] = useState(false);
  const [showSetupModal, setShowSetupModal] = useState(false);
  const [updatingDeviceId, setUpdatingDeviceId] = useState<string | null>(null);
  const [testingDeviceId, setTestingDeviceId] = useState<string | null>(null);
  const [testPhone, setTestPhone] = useState('');
  const [testMessage, setTestMessage] = useState('ZACMA SIM Bridge test SMS');
  const [sendingTest, setSendingTest] = useState(false);
  const [testFeedback, setTestFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const prevDeviceCountRef = useRef<number>(0);
  const simSlotRef = useRef<SimSlotPreference>(simSlot);

  useEffect(() => {
    simSlotRef.current = simSlot;
  }, [simSlot]);

  const generateNewQr = useCallback(async (preferredSim: SimSlotPreference) => {
    setRefreshingQr(true);
    setError(null);
    try {
      const nextSession = await createMobilePairingSession(preferredSim);
      setSession(nextSession);
      setNowMs(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to generate pairing QR code.');
    } finally {
      setRefreshingQr(false);
    }
  }, []);

  const syncStatus = useCallback(
    async (ensureSessionIfMissing = false) => {
      if (!authorized || !firebaseUser) return;
      setCheckingStatus(true);
      setError(null);
      try {
        const res = await fetchMobileDeviceStatus();
        setDevices(res.devices || []);
        if (res.activeSession) {
          setSession(res.activeSession);
          setSimSlot(res.activeSession.simSlot);
        } else if (ensureSessionIfMissing) {
          const fresh = await createMobilePairingSession('auto');
          setSession(fresh);
          setSimSlot(fresh.simSlot);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to check linked device status.');
      } finally {
        setCheckingStatus(false);
        setLoading(false);
      }
    },
    [authorized, firebaseUser]
  );

  // Initial HTTP status + QR generation
  useEffect(() => {
    if (!authorized || !firebaseUser) {
      setLoading(false);
      return;
    }
    void syncStatus(true);
  }, [authorized, firebaseUser, syncStatus]);

  // Real-time Firestore Cloud Sync for linked mobile devices (works on Vercel & AI Studio)
  useEffect(() => {
    if (!authorized || !firebaseUser) {
      setSocketState('disconnected');
      return;
    }

    setSocketState('connecting');
    const unsub = subscribeFirestoreMobileDevices(
      (nextDevices) => {
        setSocketState('connected');
        setDevices(nextDevices);
        if (nextDevices.length > prevDeviceCountRef.current && prevDeviceCountRef.current >= 0) {
          // A new handset just finished pairing; refresh active session so a fresh QR is ready
          if (prevDeviceCountRef.current > 0 || nextDevices.length > 0) {
            void refreshSimBridgeStatus();
          }
        }
        prevDeviceCountRef.current = nextDevices.length;
      },
      (err) => {
        setSocketState('disconnected');
        setError(err.message || 'Unable to connect to real-time device sync.');
      }
    );

    // Periodically re-check heartbeat freshness so stale handsets flip offline cleanly
    const freshnessTimer = window.setInterval(() => {
      void fetchMobileDeviceStatus()
        .then((res) => setDevices(res.devices || []))
        .catch(() => {});
    }, 30000);

    return () => {
      unsub();
      window.clearInterval(freshnessTimer);
    };
  }, [authorized, firebaseUser, refreshSimBridgeStatus]);

  // 1-second ticker for QR expiration countdown
  useEffect(() => {
    if (!session?.expiresAt) return;
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [session?.expiresAt]);

  const countdown = useMemo(
    () => formatCountdown(session?.expiresAt, nowMs),
    [session?.expiresAt, nowMs]
  );

  const resolvedOrigin = useMemo(() => {
    if (typeof window !== 'undefined' && window.location?.origin) {
      return window.location.origin;
    }
    return session?.serverUrl || '';
  }, [session?.serverUrl]);

  const resolvedWsUrl = useMemo(
    () => buildWebSocketUrl(resolvedOrigin, session?.wsEndpoint || '/ws/mobile-bridge'),
    [resolvedOrigin, session?.wsEndpoint]
  );

  const pairingUrl = useMemo(() => {
    if (!session || !resolvedOrigin) return '';
    return `${resolvedOrigin}/?pair=${encodeURIComponent(session.pairingCode)}&sim=${encodeURIComponent(session.simSlot)}&pin=${encodeURIComponent(session.shortPin)}`;
  }, [session, resolvedOrigin]);

  const qrPayload = useMemo(() => {
    if (!session) return '';
    return JSON.stringify({
      protocol: 'zacma-ws-bridge-v1',
      wsUrl: resolvedWsUrl,
      serverUrl: resolvedOrigin,
      pairEndpoint: session.pairEndpoint,
      pairingCode: session.pairingCode,
      shortPin: session.shortPin,
      simSlot: session.simSlot,
      expiresAt: session.expiresAt,
    });
  }, [session, resolvedOrigin, resolvedWsUrl]);

  const kotlinSnippet = useMemo(() => {
    return `// Android Secure WebSocket Pairing + SmsManager Bridge (Kotlin / OkHttp)
val request = Request.Builder().url("${resolvedWsUrl}").build()
val ws = okHttpClient.newWebSocket(request, object : WebSocketListener() {
  override fun onOpen(webSocket: WebSocket, response: Response) {
    // 1. Send single-use pairingCode scanned from ZACMA Dashboard QR
    val pairFrame = JSONObject().apply {
      put("type", "device:pair")
      put("pairingCode", scannedQr.pairingCode)
      put("deviceName", "\${Build.MANUFACTURER} \${Build.MODEL}")
      put("androidVersion", "Android \${Build.VERSION.RELEASE}")
      put("simSlot", scannedQr.simSlot)
      put("dualSimSupported", true)
    }
    webSocket.send(pairFrame.toString())
  }

  override fun onMessage(webSocket: WebSocket, text: String) {
    val msg = JSONObject(text)
    when (msg.optString("type")) {
      "device:paired" -> {
        // Store msg.getString("deviceToken") securely in EncryptedSharedPreferences
      }
      "sms:dispatch" -> {
        val jobId = msg.getString("jobId")
        val to = msg.getString("to")
        val body = msg.getString("message")
        val slot = msg.optString("simSlot", "auto")
        try {
          sendViaAndroidSmsManager(context, to, body, slot)
          webSocket.send(JSONObject(mapOf("type" to "sms:result", "jobId" to jobId, "status" to "sent")).toString())
        } catch (e: Exception) {
          webSocket.send(JSONObject(mapOf("type" to "sms:result", "jobId" to jobId, "status" to "failed", "error" to (e.message ?: "SIM error"))).toString())
        }
      }
    }
  }
})

// 2. Native Dual-SIM SMS dispatch via Android SmsManager
fun sendViaAndroidSmsManager(context: Context, to: String, body: String, slot: String) {
  val subManager = context.getSystemService(SubscriptionManager::class.java)
  val simIndex = when (slot) { "sim1" -> 0; "sim2" -> 1; else -> -1 }
  val subInfo = if (simIndex >= 0) subManager.activeSubscriptionInfoList?.getOrNull(simIndex) else null
  val smsManager = if (subInfo != null) {
    context.getSystemService(SmsManager::class.java).createForSubscriptionId(subInfo.subscriptionId)
  } else {
    context.getSystemService(SmsManager::class.java)
  }
  val parts = smsManager.divideMessage(body)
  smsManager.sendMultipartTextMessage(to, null, parts, null, null)
}`;
  }, [resolvedWsUrl]);

  const handleCopy = async (key: 'pin' | 'link' | 'payload' | 'kotlin', text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      setError('Clipboard copy failed. Select and copy manually.');
    }
  };

  const handleDownloadCompanion = async () => {
    setDownloadingCompanion(true);
    setError(null);
    try {
      const pkg = await fetchAndroidCompanionPackage();
      const combined = [
        `// ZACMA Android SIM Bridge Companion Package`,
        `// Pre-wired WebSocket Endpoint: ${pkg.wsUrl}`,
        `// Automatically prompts Android runtime permissions: SEND_SMS, READ_PHONE_STATE, POST_NOTIFICATIONS`,
        '',
        ...pkg.files.flatMap((file) => [
          `========================================================================`,
          `FILE: ${file.path}`,
          `========================================================================`,
          file.content,
          '',
        ]),
      ].join('\n');

      const blob = new Blob([combined], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'zacma-android-sim-bridge-kotlin.txt';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Unable to download Android companion source.'
      );
    } finally {
      setDownloadingCompanion(false);
    }
  };

  const handleSimPreferenceChange = async (nextSim: SimSlotPreference) => {
    setSimSlot(nextSim);
    await generateNewQr(nextSim);
  };

  const handleDeviceSimChange = async (deviceId: string, nextSim: SimSlotPreference) => {
    setUpdatingDeviceId(deviceId);
    setError(null);
    try {
      const { device } = await updateLinkedDeviceSimSlot(deviceId, nextSim);
      setDevices((prev) => upsertDevice(prev, device));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update SIM slot.');
    } finally {
      setUpdatingDeviceId(null);
    }
  };

  const handleDisconnect = async (deviceId: string) => {
    setUpdatingDeviceId(deviceId);
    setError(null);
    try {
      await disconnectLinkedDevice(deviceId);
      setDevices((prev) => prev.filter((d) => d.id !== deviceId));
      if (testingDeviceId === deviceId) {
        setTestingDeviceId(null);
      }
      void refreshSimBridgeStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect device.');
    } finally {
      setUpdatingDeviceId(null);
    }
  };

  const handleSendTestSms = async (deviceId: string) => {
    setTestFeedback(null);
    const normalized = normalizePhoneNumber(testPhone, true);
    if (!isValidE164Phone(normalized)) {
      setTestFeedback({
        type: 'error',
        text: 'Enter a valid mobile number (e.g. 0911223344 or +251911223344).',
      });
      return;
    }
    if (!testMessage.trim()) {
      setTestFeedback({ type: 'error', text: 'Enter a test message to send.' });
      return;
    }
    setSendingTest(true);
    try {
      const res = await sendMobileDeviceTestSms(deviceId, normalized, testMessage.trim());
      if (res.success) {
        setTestFeedback({
          type: 'success',
          text: `Dispatched to ${normalized} via SIM (${res.status}).`,
        });
      } else {
        setTestFeedback({
          type: 'error',
          text: res.apiResponseSummary || 'Device reported SMS failure.',
        });
      }
    } catch (err) {
      setTestFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to send test SMS through device.',
      });
    } finally {
      setSendingTest(false);
    }
  };

  const onlineCount = useMemo(() => devices.filter((d) => d.online).length, [devices]);

  return (
    <section
      id="connect-mobile-device"
      className="bg-white border border-slate-200 rounded-2xl overflow-hidden scroll-mt-20"
      aria-labelledby="connect-mobile-device-heading"
    >
      {/* Header Row */}
      <div className="px-5 py-4 sm:px-6 sm:py-5 border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-start gap-3.5 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-700 flex items-center justify-center shrink-0">
            <Smartphone className="w-5 h-5" />
          </div>
          <div className="min-w-0 space-y-0.5">
            <h2
              id="connect-mobile-device-heading"
              className="font-display text-base sm:text-lg font-bold text-slate-900"
            >
              Connect Mobile Device
            </h2>
            <p className="text-xs text-slate-500 leading-relaxed">
              Pair an Android handset over a secure WebSocket bridge (<span className="font-mono text-slate-700">WSS</span>) to dispatch SMS natively through your phone&apos;s SIM card.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <div
            className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-xl"
            role="group"
            aria-label="Preferred SIM slot"
          >
            {SIM_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => void handleSimPreferenceChange(opt.value)}
                disabled={refreshingQr}
                className={`min-h-[36px] px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-60 ${
                  simSlot === opt.value
                    ? 'bg-white text-blue-700 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => void generateNewQr(simSlot)}
            disabled={refreshingQr}
            className="min-h-[42px] px-3.5 py-2 rounded-xl border border-slate-300 hover:bg-slate-50 text-xs font-semibold text-slate-800 inline-flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-60"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshingQr ? 'animate-spin' : ''}`} />
            Regenerate QR
          </button>
        </div>
      </div>

      {/* Main Content Split: QR Code + Secure WebSocket Setup Instructions */}
      <div className="p-5 sm:p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 items-start">
        {/* Left Column: Scannable QR Code & Fallback Pairing Code */}
        <div className="lg:col-span-5 flex flex-col items-center text-center space-y-4">
          <div className="w-full max-w-[260px] bg-slate-50 border border-slate-200 rounded-2xl p-5 flex flex-col items-center justify-center">
            {loading || refreshingQr ? (
              <div className="w-[188px] h-[188px] rounded-xl bg-slate-200/70 animate-pulse flex items-center justify-center">
                <span className="text-xs font-medium text-slate-500">Generating QR...</span>
              </div>
            ) : session && !countdown.expired ? (
              <div className="bg-white p-3 rounded-xl border border-slate-200">
                <QRCodeSVG
                  value={pairingUrl || qrPayload}
                  size={172}
                  level="M"
                  bgColor="#FFFFFF"
                  fgColor="#0F172A"
                  title="ZACMA Android SIM Pairing QR Code"
                />
              </div>
            ) : (
              <div className="w-[188px] h-[188px] rounded-xl bg-white border border-slate-200 flex flex-col items-center justify-center p-4 space-y-3">
                <p className="text-xs font-semibold text-slate-800">
                  {session ? 'QR Code Expired' : 'QR Code Unavailable'}
                </p>
                <p className="text-[11px] text-slate-500 leading-snug">
                  {session
                    ? 'Single-use pairing tokens expire after 10 minutes for device security.'
                    : error || 'Tap below to generate a fresh single-use pairing QR code.'}
                </p>
                <button
                  type="button"
                  onClick={() => void generateNewQr(simSlot)}
                  className="min-h-[40px] px-3.5 py-2 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold cursor-pointer whitespace-nowrap"
                >
                  Generate Fresh QR
                </button>
              </div>
            )}

            {/* Unboxed Metadata Row */}
            <div className="mt-3.5 flex items-center justify-center gap-2 text-xs text-slate-600 font-mono tabular-nums">
              <span>{countdown.expired ? 'Expired' : `Expires in ${countdown.text}`}</span>
              <span aria-hidden="true">·</span>
              <span className="uppercase">{simSlot === 'auto' ? 'Auto SIM' : simSlot}</span>
            </div>
          </div>

          {/* Pairing PIN & Quick Copy Controls */}
          {session && (
            <div className="w-full max-w-[260px] space-y-2.5">
              {pairingUrl && !countdown.expired && (
                <a
                  href={pairingUrl}
                  className="w-full min-h-[42px] px-3.5 py-2 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold inline-flex items-center justify-center gap-2 transition-colors"
                >
                  <Smartphone className="w-3.5 h-3.5" />
                  Pair This Phone Directly
                </a>
              )}

              <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-left">
                <div className="min-w-0">
                  <p className="text-[11px] text-slate-500">Pairing PIN</p>
                  <p className="font-mono tabular-nums text-sm font-semibold text-slate-900 truncate">
                    {session.shortPin}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleCopy('pin', session.shortPin)}
                  className="min-h-[36px] min-w-[36px] px-2.5 rounded-lg hover:bg-slate-200/70 text-slate-700 inline-flex items-center justify-center gap-1 text-xs font-medium cursor-pointer transition-colors shrink-0"
                  aria-label="Copy pairing PIN"
                >
                  {copiedKey === 'pin' ? (
                    <Check className="w-3.5 h-3.5 text-emerald-700" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => void handleCopy('link', pairingUrl)}
                  className="min-h-[40px] px-2.5 py-2 rounded-xl border border-slate-300 hover:bg-slate-50 text-xs font-semibold text-slate-800 inline-flex items-center justify-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap"
                >
                  {copiedKey === 'link' ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-700" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Link2 className="w-3.5 h-3.5" />
                      Copy Link
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => void handleCopy('payload', qrPayload)}
                  className="min-h-[40px] px-2.5 py-2 rounded-xl border border-slate-300 hover:bg-slate-50 text-xs font-semibold text-slate-800 inline-flex items-center justify-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap"
                >
                  {copiedKey === 'payload' ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-700" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      Copy JSON
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Real Live WebSocket Bridge Connection Telemetry */}
          <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-slate-600">
            <span className="inline-flex items-center gap-1.5 font-medium">
              <span
                className={`w-2 h-2 rounded-full ${
                  socketState === 'connected'
                    ? 'bg-emerald-600'
                    : socketState === 'reconnecting' || socketState === 'connecting'
                      ? 'bg-amber-500'
                      : 'bg-slate-400'
                }`}
                aria-hidden="true"
              />
              {socketState === 'connected'
                ? 'Live Cloud Sync connected'
                : socketState === 'reconnecting'
                  ? 'Reconnecting Cloud Sync...'
                  : socketState === 'connecting'
                    ? 'Connecting Cloud Sync...'
                    : 'Sync offline'}
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">
              {onlineCount}/{devices.length} online
            </span>
          </div>
        </div>

        {/* Right Column: Step-by-Step Android WebSocket Pairing Instructions */}
        <div className="lg:col-span-7 space-y-5">
          <div className="space-y-1">
            <h3 className="font-display text-sm font-bold text-slate-900">
              How to Link Your Android Phone via Secure WebSocket
            </h3>
            <p className="text-xs text-slate-500">
              Your handset maintains an authenticated <span className="font-mono text-slate-700">wss://</span> link to ZACMA so queued SMS messages dispatch instantly through your SIM card.
            </p>
          </div>

          <ol className="divide-y divide-slate-100 border-t border-b border-slate-100">
            <li className="py-3.5 flex items-start gap-3.5">
              <span className="font-mono tabular-nums text-xs font-semibold text-blue-700 pt-0.5 shrink-0">
                01.
              </span>
              <div className="space-y-0.5">
                <p className="text-sm font-semibold text-slate-900">
                  Prepare your Android SIM &amp; internet access
                </p>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Ensure an active Ethio Telecom or Safaricom SIM card with SMS balance is inserted
                  and the handset is connected to Wi-Fi or mobile data.
                </p>
              </div>
            </li>

            <li className="py-3.5 flex items-start gap-3.5">
              <span className="font-mono tabular-nums text-xs font-semibold text-blue-700 pt-0.5 shrink-0">
                02.
              </span>
              <div className="space-y-0.5">
                <p className="text-sm font-semibold text-slate-900">
                  Scan the QR code with your phone camera (Instant Mode)
                </p>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Point your Android camera at the QR code (or tap <strong>Pair This Phone Directly</strong> on mobile). It opens the ZACMA Phone SIM Bridge immediately—no extra app install required—and routes messages straight to your phone&apos;s SMS app.
                </p>
              </div>
            </li>

            <li className="py-3.5 flex items-start gap-3.5">
              <span className="font-mono tabular-nums text-xs font-semibold text-blue-700 pt-0.5 shrink-0">
                03.
              </span>
              <div className="space-y-0.5">
                <p className="text-sm font-semibold text-slate-900">
                  Optional: Native Android Companion for unattended bulk SMS
                </p>
                <p className="text-xs text-slate-600 leading-relaxed">
                  For fully automatic background Dual-SIM sending via Android&apos;s{' '}
                  <code className="font-mono text-slate-800">SmsManager</code>, download the pre-wired
                  Kotlin companion below. On launch it automatically pops up Android&apos;s permission
                  dialog for <code className="font-mono text-slate-800">SEND_SMS</code> and{' '}
                  <code className="font-mono text-slate-800">READ_PHONE_STATE</code>.
                </p>
              </div>
            </li>

            <li className="py-3.5 flex items-start gap-3.5">
              <span className="font-mono tabular-nums text-xs font-semibold text-blue-700 pt-0.5 shrink-0">
                04.
              </span>
              <div className="space-y-0.5">
                <p className="text-sm font-semibold text-slate-900">
                  Live WebSocket sync &amp; instant SIM dispatch
                </p>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Once linked, your handset appears online below with a permanent hashed device token
                  and can switch between Auto SIM, SIM 1, or SIM 2 anytime.
                </p>
              </div>
            </li>
          </ol>

          {/* Action Buttons */}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void handleDownloadCompanion()}
              disabled={downloadingCompanion}
              className="min-h-[42px] px-4 py-2 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold inline-flex items-center gap-2 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-60"
            >
              <Download className="w-3.5 h-3.5" />
              {downloadingCompanion ? 'Preparing Source...' : 'Download Android Kotlin Companion'}
            </button>

            <button
              type="button"
              onClick={() => setShowSetupModal(true)}
              className="min-h-[42px] px-4 py-2 rounded-xl border border-slate-300 hover:bg-slate-50 text-xs font-semibold text-slate-800 inline-flex items-center gap-2 transition-colors cursor-pointer whitespace-nowrap"
            >
              <BookOpen className="w-3.5 h-3.5 text-slate-600" />
              Install &amp; Permissions Guide
            </button>

            <button
              type="button"
              onClick={() => void syncStatus(false)}
              disabled={checkingStatus}
              className="min-h-[42px] px-4 py-2 rounded-xl border border-slate-300 hover:bg-slate-50 text-xs font-semibold text-slate-800 inline-flex items-center gap-2 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-60"
            >
              <RefreshCw className={`w-3.5 h-3.5 text-slate-600 ${checkingStatus ? 'animate-spin' : ''}`} />
              Sync Device State
            </button>

            <button
              type="button"
              onClick={() => setShowTechnicalGuide((prev) => !prev)}
              className="min-h-[42px] px-4 py-2 rounded-xl border border-slate-300 hover:bg-slate-50 text-xs font-semibold text-slate-800 inline-flex items-center gap-2 transition-colors cursor-pointer whitespace-nowrap"
            >
              <Code2 className="w-3.5 h-3.5 text-slate-600" />
              WebSocket &amp; Kotlin Contract
              {showTechnicalGuide ? (
                <ChevronUp className="w-3.5 h-3.5 text-slate-500" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
              )}
            </button>
          </div>

          {/* Error Feedback */}
          {error && (
            <p className="text-xs font-medium text-red-600" role="alert">
              {error}
            </p>
          )}

          {/* Collapsible Android Companion Integration Details */}
          {showTechnicalGuide && (
            <div className="rounded-xl bg-slate-950 text-slate-100 p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-semibold text-slate-200">
                  Android WebSocket Handshake &amp; SmsManager Reference
                </p>
                <button
                  type="button"
                  onClick={() => void handleCopy('kotlin', kotlinSnippet)}
                  className="min-h-[34px] px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
                >
                  {copiedKey === 'kotlin' ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      Copy Snippet
                    </>
                  )}
                </button>
              </div>
              <pre className="text-[11px] leading-relaxed font-mono text-slate-300 overflow-x-auto whitespace-pre">
                {kotlinSnippet}
              </pre>
            </div>
          )}
        </div>
      </div>

      {/* Linked Android Devices Section */}
      {devices.length > 0 && (
        <div className="border-t border-slate-200">
          <div className="px-5 py-3 sm:px-6 bg-slate-50 border-b border-slate-200 flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-slate-700">
              Linked Android Devices ({devices.length})
            </h3>
            <span className="text-xs text-slate-500 font-mono tabular-nums">
              {onlineCount} live online
            </span>
          </div>
          <div className="divide-y divide-slate-100">
            {devices.map((device) => (
              <div
                key={device.id}
                className="px-5 py-3.5 sm:px-6 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <p className="text-sm font-semibold text-slate-900 truncate">
                      {device.deviceName}
                    </p>
                    <span
                      className={`text-xs font-semibold whitespace-nowrap ${
                        device.online ? 'text-emerald-700' : 'text-slate-500'
                      }`}
                    >
                      {device.online ? 'Online' : 'Offline'}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 font-mono tabular-nums truncate">
                    {device.phoneNumber} · {device.carrierName} ·{' '}
                    {device.clientType === 'mobile-web' ? 'Mobile Web SIM' : 'Native SmsManager'} ·{' '}
                    {device.androidVersion} · Seen {formatRelativeTime(device.lastSeenAt)}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                  <div className="inline-flex items-center gap-1 p-0.5 bg-slate-100 rounded-lg">
                    {SIM_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        disabled={updatingDeviceId === device.id}
                        onClick={() => void handleDeviceSimChange(device.id, opt.value)}
                        className={`min-h-[34px] px-2.5 py-1 rounded-md text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 ${
                          device.simSlot === opt.value
                            ? 'bg-white text-blue-700 shadow-xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>

                  {device.online && (
                    <button
                      type="button"
                      onClick={() => {
                        setTestFeedback(null);
                        setTestingDeviceId((prev) => (prev === device.id ? null : device.id));
                      }}
                      className="min-h-[36px] px-3 py-1.5 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap"
                    >
                      <Send className="w-3.5 h-3.5" />
                      Test SIM SMS
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={updatingDeviceId === device.id}
                    onClick={() => void handleDisconnect(device.id)}
                    className="min-h-[36px] px-3 py-1.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 text-xs font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Unlink
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Inline Live SIM Test SMS Drawer for Selected Online Device */}
          {testingDeviceId && devices.some((d) => d.id === testingDeviceId && d.online) && (
            <div className="px-5 py-4 sm:px-6 bg-slate-50 border-t border-slate-200 space-y-3">
              <div className="flex flex-col sm:flex-row gap-2.5">
                <input
                  type="tel"
                  value={testPhone}
                  onChange={(e) => setTestPhone(e.target.value)}
                  placeholder="Recipient number (e.g. 0911223344)"
                  className="min-h-[42px] sm:w-56 px-3.5 py-2 rounded-xl bg-white border border-slate-300 text-xs text-slate-900 font-mono placeholder:font-sans placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
                <input
                  type="text"
                  value={testMessage}
                  onChange={(e) => setTestMessage(e.target.value)}
                  placeholder="Test message"
                  maxLength={320}
                  className="min-h-[42px] flex-1 px-3.5 py-2 rounded-xl bg-white border border-slate-300 text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
                <button
                  type="button"
                  disabled={sendingTest}
                  onClick={() => void handleSendTestSms(testingDeviceId)}
                  className="min-h-[42px] px-4 py-2 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-60"
                >
                  <Send className="w-3.5 h-3.5" />
                  {sendingTest ? 'Sending...' : 'Send via SIM'}
                </button>
              </div>
              {testFeedback && (
                <p
                  className={`text-xs font-medium ${
                    testFeedback.type === 'success' ? 'text-emerald-700' : 'text-red-600'
                  }`}
                >
                  {testFeedback.text}
                </p>
              )}
            </div>
          )}
        </div>
      )}
      <AndroidSetupGuideModal
        open={showSetupModal}
        onClose={() => setShowSetupModal(false)}
        shortPin={session?.shortPin}
        wsUrl={resolvedWsUrl}
      />
    </section>
  );
}
