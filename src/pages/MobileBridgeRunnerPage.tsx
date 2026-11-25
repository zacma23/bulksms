import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  ExternalLink,
  MessageSquare,
  Power,
  RefreshCw,
  Send,
  Smartphone,
  Sun,
  X,
} from 'lucide-react';
import { ZacmaBrandMark } from '../components/ZacmaBrandMark';
import { isValidE164Phone, normalizePhoneNumber } from '../lib/smsUtils';
import type { LinkedMobileDevice, SimSlotPreference } from '../types/portal';

const STORAGE_KEY = 'zacma_mobile_bridge_creds_v1';

const SIM_OPTIONS: { value: SimSlotPreference; label: string }[] = [
  { value: 'auto', label: 'Auto SIM' },
  { value: 'sim1', label: 'SIM 1' },
  { value: 'sim2', label: 'SIM 2' },
];

const CARRIER_PRESETS = ['Ethio Telecom', 'Safaricom Ethiopia'];

interface StoredDeviceCredentials {
  deviceId: string;
  deviceToken: string;
  device: LinkedMobileDevice;
}

interface IncomingSmsJob {
  jobId: string;
  to: string;
  message: string;
  simSlot: SimSlotPreference;
  receivedAt: string;
  openedInSmsApp?: boolean;
}

interface CompletedSmsJob {
  jobId: string;
  to: string;
  message: string;
  status: 'sent' | 'failed';
  completedAt: string;
}

type BridgeSocketState = 'idle' | 'connecting' | 'pairing' | 'online' | 'reconnecting';

function detectHandsetDefaults(): { deviceName: string; androidVersion: string; isIos: boolean } {
  if (typeof navigator === 'undefined') {
    return { deviceName: 'Android Handset', androidVersion: 'Android', isIos: false };
  }
  const ua = navigator.userAgent || '';
  const isIos = /iPhone|iPad|iPod/i.test(ua);
  const androidMatch = ua.match(/Android\s+([0-9.]+)/i);
  const androidVersion = androidMatch
    ? `Android ${androidMatch[1]}`
    : isIos
      ? 'iOS Mobile Browser'
      : 'Mobile Browser';

  const modelMatch = ua.match(/Android\s+[0-9.]+;\s*([^;)]+?)(?:\s+Build\/|[;)])/i);
  const rawModel = modelMatch?.[1]?.trim();
  const deviceName =
    rawModel && rawModel.length >= 2 && rawModel.toLowerCase() !== 'k'
      ? rawModel
      : isIos
        ? 'iPhone SIM Bridge'
        : 'Android Phone SIM';

  return { deviceName, androidVersion, isIos };
}

function buildWebSocketUrl(): string {
  if (typeof window === 'undefined') return '/ws/mobile-bridge';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws/mobile-bridge`;
}

function extractPairingInput(rawInput: string): {
  pairingCode: string;
  simSlot?: SimSlotPreference;
} {
  const trimmed = rawInput.trim();
  if (!trimmed) return { pairingCode: '' };

  // Support pasted JSON payload from QR
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { pairingCode?: string; simSlot?: string };
      const sim =
        parsed.simSlot === 'sim1' || parsed.simSlot === 'sim2' || parsed.simSlot === 'auto'
          ? parsed.simSlot
          : undefined;
      return { pairingCode: String(parsed.pairingCode || '').trim(), simSlot: sim };
    } catch {
      return { pairingCode: trimmed };
    }
  }

  // Support pasted full pairing URL (?pair=...)
  if (trimmed.includes('pair=')) {
    try {
      const url = new URL(trimmed.startsWith('http') ? trimmed : `https://zacma.local/?${trimmed}`);
      const code = url.searchParams.get('pair')?.trim() || '';
      const simParam = url.searchParams.get('sim');
      const sim =
        simParam === 'sim1' || simParam === 'sim2' || simParam === 'auto'
          ? simParam
          : undefined;
      if (code) return { pairingCode: code, simSlot: sim };
    } catch {
      // Fall through to raw code
    }
  }

  return { pairingCode: trimmed };
}

function buildSmsUri(to: string, message: string, isIos: boolean): string {
  const cleanTo = to.replace(/[^0-9+]/g, '');
  const sep = isIos ? '&' : '?';
  return `sms:${cleanTo}${sep}body=${encodeURIComponent(message)}`;
}

function readStoredCredentials(): StoredDeviceCredentials | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredDeviceCredentials>;
    if (parsed.deviceId && parsed.deviceToken && parsed.device) {
      return parsed as StoredDeviceCredentials;
    }
    return null;
  } catch {
    return null;
  }
}

function saveStoredCredentials(creds: StoredDeviceCredentials | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (!creds) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(creds));
    }
  } catch {
    // Ignore storage quota errors
  }
}

export function MobileBridgeRunnerPage() {
  const handset = useMemo(() => detectHandsetDefaults(), []);

  const initialQuery = useMemo(() => {
    if (typeof window === 'undefined') {
      return { pair: '', sim: 'auto' as SimSlotPreference, pin: '' };
    }
    const params = new URLSearchParams(window.location.search);
    const pair = params.get('pair')?.trim() || '';
    const simRaw = params.get('sim');
    const sim: SimSlotPreference =
      simRaw === 'sim1' || simRaw === 'sim2' || simRaw === 'auto' ? simRaw : 'auto';
    const pin = params.get('pin')?.trim() || '';
    return { pair, sim, pin };
  }, []);

  const [storedCreds, setStoredCreds] = useState<StoredDeviceCredentials | null>(() => {
    // If the user explicitly scanned a new ?pair= QR code, prioritize pairing the new token
    if (initialQuery.pair) return null;
    return readStoredCredentials();
  });

  const [pairingInput, setPairingInput] = useState(initialQuery.pair);
  const [deviceName, setDeviceName] = useState(handset.deviceName);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [carrierName, setCarrierName] = useState(CARRIER_PRESETS[0]);
  const [simSlot, setSimSlot] = useState<SimSlotPreference>(initialQuery.sim);

  const [socketState, setSocketState] = useState<BridgeSocketState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingJobs, setPendingJobs] = useState<IncomingSmsJob[]>([]);
  const [recentJobs, setRecentJobs] = useState<CompletedSmsJob[]>([]);
  const [wakeLockActive, setWakeLockActive] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
  const credsRef = useRef<StoredDeviceCredentials | null>(storedCreds);

  useEffect(() => {
    credsRef.current = storedCreds;
  }, [storedCreds]);

  const closeSocket = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {
        // Ignore close error
      }
      wsRef.current = null;
    }
  }, []);

  const handleServerFrame = useCallback((rawData: string) => {
    try {
      const msg = JSON.parse(rawData) as {
        type?: string;
        deviceId?: string;
        deviceToken?: string;
        device?: LinkedMobileDevice;
        simSlot?: SimSlotPreference;
        jobId?: string;
        to?: string;
        message?: string;
        error?: string;
      };

      if (msg.type === 'device:paired' && msg.deviceToken && msg.device) {
        const resolvedDeviceId = msg.deviceId || msg.device.id;
        const nextCreds: StoredDeviceCredentials = {
          deviceId: resolvedDeviceId,
          deviceToken: msg.deviceToken,
          device: msg.device,
        };
        saveStoredCredentials(nextCreds);
        setStoredCreds(nextCreds);
        setSocketState('online');
        setError(null);
        setNotice('Phone linked live to ZACMA Portal. Keep this tab open to send SMS via your SIM.');
        reconnectAttemptRef.current = 0;
        if (typeof window !== 'undefined') {
          window.history.replaceState({}, '', `${window.location.pathname}?mode=phone-bridge`);
        }
        return;
      }

      if ((msg.type === 'device:ready' || msg.type === 'device:authed') && msg.device) {
        setStoredCreds((prev) => {
          if (!prev) return prev;
          const updated = { ...prev, device: msg.device! };
          saveStoredCredentials(updated);
          return updated;
        });
        setSocketState('online');
        setError(null);
        reconnectAttemptRef.current = 0;
        return;
      }

      if (msg.type === 'sim:update' && msg.simSlot) {
        const updatedSlot = msg.simSlot;
        setStoredCreds((prev) => {
          if (!prev) return prev;
          const updated = {
            ...prev,
            device: { ...prev.device, simSlot: updatedSlot },
          };
          saveStoredCredentials(updated);
          return updated;
        });
        setNotice(`SIM routing switched to ${updatedSlot.toUpperCase()} from dashboard.`);
        return;
      }

      if (msg.type === 'sms:dispatch' && msg.jobId && msg.to && typeof msg.message === 'string') {
        const incoming: IncomingSmsJob = {
          jobId: msg.jobId,
          to: msg.to,
          message: msg.message,
          simSlot: msg.simSlot || 'auto',
          receivedAt: new Date().toISOString(),
        };
        setPendingJobs((prev) => {
          if (prev.some((j) => j.jobId === incoming.jobId)) return prev;
          return [incoming, ...prev];
        });
        if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
          try {
            navigator.vibrate(120);
          } catch {
            // Ignore vibration restrictions
          }
        }
        return;
      }

      if (msg.type === 'device:unlinked') {
        saveStoredCredentials(null);
        setStoredCreds(null);
        setPendingJobs([]);
        setSocketState('idle');
        setNotice('This phone was unlinked from the ZACMA dashboard.');
        return;
      }

      if (msg.type === 'pair:error') {
        setError(msg.error || 'Pairing code expired or invalid. Regenerate a fresh QR on the dashboard.');
        setSocketState('idle');
        return;
      }

      if (msg.type === 'auth:error') {
        saveStoredCredentials(null);
        setStoredCreds(null);
        setSocketState('idle');
        setError(msg.error || 'Saved device session expired. Scan a fresh QR code to re-link.');
      }
    } catch {
      // Ignore malformed socket frames
    }
  }, []);

  // Maintain live WebSocket connection automatically when paired credentials exist
  useEffect(() => {
    if (!storedCreds) {
      return;
    }

    // If a live socket is already open from the initial device:pair handshake, keep it
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      setSocketState('online');
    }

    let disposed = false;

    const ensureConnected = () => {
      if (disposed || !credsRef.current) return;
      if (
        wsRef.current &&
        (wsRef.current.readyState === WebSocket.OPEN ||
          wsRef.current.readyState === WebSocket.CONNECTING)
      ) {
        return;
      }

      setSocketState(reconnectAttemptRef.current > 0 ? 'reconnecting' : 'connecting');
      const ws = new WebSocket(buildWebSocketUrl());
      wsRef.current = ws;

      ws.addEventListener('open', () => {
        if (disposed || !credsRef.current) {
          ws.close();
          return;
        }
        ws.send(
          JSON.stringify({
            type: 'device:auth',
            deviceId: credsRef.current.deviceId,
            deviceToken: credsRef.current.deviceToken,
          })
        );
      });

      ws.addEventListener('message', (event) => {
        handleServerFrame(String(event.data || '{}'));
      });

      ws.addEventListener('close', (event) => {
        if (disposed || !credsRef.current) return;
        if (event.code === 4003 || event.code === 4001) {
          saveStoredCredentials(null);
          setStoredCreds(null);
          setPendingJobs([]);
          setSocketState('idle');
          setNotice('This phone was unlinked or its session expired. Scan a fresh QR code to re-link.');
          return;
        }
        setSocketState('reconnecting');
        const attempt = reconnectAttemptRef.current;
        const delayMs = Math.min(12000, 1000 * Math.pow(2, attempt));
        reconnectAttemptRef.current = Math.min(attempt + 1, 5);
        reconnectTimerRef.current = window.setTimeout(() => {
          ensureConnected();
        }, delayMs);
      });

      ws.addEventListener('error', () => {
        // Close listener handles reconnect
      });
    };

    ensureConnected();

    const pingTimer = window.setInterval(() => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'ping' }));
      }
    }, 25000);

    return () => {
      disposed = true;
      window.clearInterval(pingTimer);
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };
  }, [storedCreds, handleServerFrame]);

  // Clean up socket & wake lock on unmount
  useEffect(() => {
    return () => {
      closeSocket();
      if (wakeLockRef.current) {
        void wakeLockRef.current.release();
        wakeLockRef.current = null;
      }
    };
  }, [closeSocket]);

  const handlePairNow = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);

    const parsed = extractPairingInput(pairingInput);
    if (!parsed.pairingCode) {
      setError('Scan a dashboard QR code or paste the pairing link/code first.');
      return;
    }

    const trimmedPhone = phoneNumber.trim();
    let formattedPhone = 'Android SIM';
    if (trimmedPhone) {
      const normalized = normalizePhoneNumber(trimmedPhone, true);
      formattedPhone = isValidE164Phone(normalized) ? normalized : trimmedPhone;
    }

    const effectiveSim = parsed.simSlot || simSlot;
    closeSocket();
    setSocketState('pairing');

    const ws = new WebSocket(buildWebSocketUrl());
    wsRef.current = ws;

    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          type: 'device:pair',
          pairingCode: parsed.pairingCode,
          deviceName: deviceName.trim() || handset.deviceName,
          androidVersion: handset.androidVersion,
          phoneNumber: formattedPhone,
          carrierName: carrierName.trim() || 'Ethio Telecom',
          simSlot: effectiveSim,
          dualSimSupported: true,
          clientType: 'mobile-web',
        })
      );
    });

    ws.addEventListener('message', (event) => {
      handleServerFrame(String(event.data || '{}'));
    });

    ws.addEventListener('close', () => {
      if (!credsRef.current) {
        setSocketState('idle');
      }
    });

    ws.addEventListener('error', () => {
      setError('Could not connect to ZACMA WebSocket bridge. Check your internet connection.');
      setSocketState('idle');
    });
  };

  const handleMarkSmsOpened = (jobId: string) => {
    setPendingJobs((prev) =>
      prev.map((j) => (j.jobId === jobId ? { ...j, openedInSmsApp: true } : j))
    );
  };

  const handleReportJobResult = (job: IncomingSmsJob, status: 'sent' | 'failed') => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: 'sms:result',
          jobId: job.jobId,
          status,
          ...(status === 'failed' ? { error: 'Marked failed on paired phone' } : {}),
        })
      );
      if (status === 'sent') {
        window.setTimeout(() => {
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(
              JSON.stringify({
                type: 'sms:dlr',
                jobId: job.jobId,
                status: 'delivered',
              })
            );
          }
        }, 400);
      }
    }

    setPendingJobs((prev) => prev.filter((j) => j.jobId !== job.jobId));
    setRecentJobs((prev) => [
      {
        jobId: job.jobId,
        to: job.to,
        message: job.message,
        status,
        completedAt: new Date().toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
        }),
      },
      ...prev.slice(0, 19),
    ]);
  };

  const handleUnpairLocally = () => {
    closeSocket();
    saveStoredCredentials(null);
    setStoredCreds(null);
    setPendingJobs([]);
    setSocketState('idle');
    setNotice('Disconnected from this browser. You can re-pair with a fresh QR code anytime.');
  };

  const handleToggleWakeLock = async () => {
    if (wakeLockActive && wakeLockRef.current) {
      try {
        await wakeLockRef.current.release();
      } catch {
        // Ignore release errors
      }
      wakeLockRef.current = null;
      setWakeLockActive(false);
      return;
    }

    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> };
    };
    if (!nav.wakeLock) {
      setNotice('Keep-screen-awake is not supported on this browser; keep the tab active while sending.');
      return;
    }
    try {
      const lock = await nav.wakeLock.request('screen');
      wakeLockRef.current = lock;
      setWakeLockActive(true);
    } catch {
      setNotice('Could not activate screen wake lock. Keep your phone screen awake during sending.');
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      {/* Compact Mobile Header */}
      <header className="sticky top-0 z-20 bg-white border-b border-slate-200 px-4 py-3">
        <div className="max-w-lg mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <ZacmaBrandMark size={34} />
            <div className="min-w-0">
              <p className="font-display font-bold text-sm text-slate-900 truncate">
                ZACMA Phone SIM Bridge
              </p>
              <p className="text-[11px] text-slate-500 truncate">
                Direct Mobile SIM Dispatcher
              </p>
            </div>
          </div>

          <a
            href="/"
            className="min-h-[38px] px-3 py-1.5 rounded-xl border border-slate-300 hover:bg-slate-50 text-xs font-semibold text-slate-700 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Portal
          </a>
        </div>
      </header>

      <main className="flex-1 px-4 py-5 max-w-lg w-full mx-auto space-y-5">
        {/* Feedback banners */}
        {error && (
          <div
            role="alert"
            className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-xs font-medium text-red-700"
          >
            {error}
          </div>
        )}
        {notice && !error && (
          <div className="p-3.5 rounded-xl bg-blue-50 border border-blue-200 text-xs font-medium text-blue-800">
            {notice}
          </div>
        )}

        {!storedCreds ? (
          /* Pairing Form View */
          <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-5">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-700 flex items-center justify-center shrink-0">
                <Smartphone className="w-5 h-5" />
              </div>
              <div className="space-y-1">
                <h1 className="font-display text-base font-bold text-slate-900">
                  Link This Phone to ZACMA
                </h1>
                <p className="text-xs text-slate-500 leading-relaxed">
                  {initialQuery.pair
                    ? 'QR pairing code detected automatically. Confirm your SIM details below and tap Link This Phone.'
                    : 'Scan the QR code from your ZACMA Dashboard with your phone camera, or paste the pairing link below.'}
                </p>
              </div>
            </div>

            <form onSubmit={handlePairNow} className="space-y-4">
              {initialQuery.pin && initialQuery.pair ? (
                <div className="flex items-center justify-between px-3.5 py-2.5 rounded-xl bg-slate-50 border border-slate-200">
                  <span className="text-xs text-slate-600">Detected QR Session PIN</span>
                  <span className="font-mono tabular-nums text-xs font-bold text-blue-700">
                    {initialQuery.pin}
                  </span>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <label
                    htmlFor="zacma-pair-code"
                    className="block text-xs font-semibold text-slate-700"
                  >
                    Pairing Link or Code
                  </label>
                  <input
                    id="zacma-pair-code"
                    type="text"
                    value={pairingInput}
                    onChange={(e) => setPairingInput(e.target.value)}
                    placeholder="Paste pairing link, code, or QR JSON"
                    className="w-full min-h-[44px] px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm font-mono text-slate-900 placeholder:font-sans placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                    required
                  />
                </div>
              )}

              <div className="space-y-1.5">
                <label
                  htmlFor="zacma-device-name"
                  className="block text-xs font-semibold text-slate-700"
                >
                  Phone Label
                </label>
                <input
                  id="zacma-device-name"
                  type="text"
                  value={deviceName}
                  onChange={(e) => setDeviceName(e.target.value)}
                  placeholder="e.g. Samsung Galaxy A54"
                  maxLength={80}
                  className="w-full min-h-[44px] px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="zacma-sim-number"
                  className="block text-xs font-semibold text-slate-700"
                >
                  Your SIM Phone Number
                </label>
                <input
                  id="zacma-sim-number"
                  type="tel"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  placeholder="e.g. 0911223344 or +251911223344"
                  className="w-full min-h-[44px] px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm font-mono text-slate-900 placeholder:font-sans placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
                <p className="text-[11px] text-slate-500">
                  Shown as the sending SIM number in campaign logs and history.
                </p>
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="zacma-carrier"
                  className="block text-xs font-semibold text-slate-700"
                >
                  Mobile Network Operator
                </label>
                <div className="flex flex-wrap gap-2 mb-1.5">
                  {CARRIER_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setCarrierName(preset)}
                      className={`min-h-[36px] px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors cursor-pointer whitespace-nowrap ${
                        carrierName === preset
                          ? 'bg-blue-50 border-blue-300 text-blue-700'
                          : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
                <input
                  id="zacma-carrier"
                  type="text"
                  value={carrierName}
                  onChange={(e) => setCarrierName(e.target.value)}
                  placeholder="Mobile carrier name"
                  maxLength={60}
                  className="w-full min-h-[44px] px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div className="space-y-1.5">
                <span className="block text-xs font-semibold text-slate-700">
                  Preferred SIM Slot
                </span>
                <div
                  className="grid grid-cols-3 gap-1.5 p-1 bg-slate-100 rounded-xl"
                  role="group"
                  aria-label="Preferred SIM slot"
                >
                  {SIM_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setSimSlot(opt.value)}
                      className={`min-h-[40px] px-3 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                        simSlot === opt.value
                          ? 'bg-white text-blue-700 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <button
                type="submit"
                disabled={socketState === 'pairing'}
                className="w-full min-h-[48px] px-4 py-3 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-sm font-semibold inline-flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:opacity-60"
              >
                {socketState === 'pairing' ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Linking Phone...
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4" />
                    Link This Phone Now
                  </>
                )}
              </button>
            </form>
          </section>
        ) : (
          /* Paired Live SIM Dispatcher View */
          <>
            <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span
                      className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                        socketState === 'online'
                          ? 'bg-emerald-600'
                          : socketState === 'reconnecting' || socketState === 'connecting'
                            ? 'bg-amber-500'
                            : 'bg-slate-400'
                      }`}
                      aria-hidden="true"
                    />
                    <h1 className="font-display text-base font-bold text-slate-900 truncate">
                      {storedCreds.device.deviceName}
                    </h1>
                  </div>
                  <p className="text-xs text-slate-600 font-mono tabular-nums truncate">
                    {storedCreds.device.phoneNumber} · {storedCreds.device.carrierName} ·{' '}
                    {storedCreds.device.simSlot.toUpperCase()}
                  </p>
                </div>

                <span
                  className={`text-xs font-semibold whitespace-nowrap ${
                    socketState === 'online' ? 'text-emerald-700' : 'text-amber-700'
                  }`}
                >
                  {socketState === 'online'
                    ? 'Live & Ready'
                    : socketState === 'reconnecting'
                      ? 'Reconnecting...'
                      : 'Connecting...'}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2.5 pt-1">
                <button
                  type="button"
                  onClick={() => void handleToggleWakeLock()}
                  className={`min-h-[42px] px-3.5 py-2 rounded-xl border text-xs font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap ${
                    wakeLockActive
                      ? 'bg-blue-50 border-blue-300 text-blue-700'
                      : 'border-slate-300 text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <Sun className="w-3.5 h-3.5" />
                  {wakeLockActive ? 'Screen Awake On' : 'Keep Screen Awake'}
                </button>

                <button
                  type="button"
                  onClick={handleUnpairLocally}
                  className="min-h-[42px] px-3.5 py-2 rounded-xl border border-red-200 text-red-600 hover:bg-red-50 text-xs font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap"
                >
                  <Power className="w-3.5 h-3.5" />
                  Disconnect Phone
                </button>
              </div>
            </section>

            {/* Incoming SMS Queue */}
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-sm font-bold text-slate-900">
                  Incoming SMS Queue ({pendingJobs.length})
                </h2>
                <span className="text-xs text-slate-500">
                  Tap to send via phone&apos;s SIM
                </span>
              </div>

              {pendingJobs.length === 0 ? (
                <div className="bg-white border border-slate-200 rounded-2xl p-6 text-center space-y-2">
                  <div className="w-10 h-10 rounded-xl bg-slate-100 text-slate-500 flex items-center justify-center mx-auto">
                    <MessageSquare className="w-5 h-5" />
                  </div>
                  <p className="text-sm font-semibold text-slate-900">
                    Waiting for SMS from ZACMA Portal
                  </p>
                  <p className="text-xs text-slate-500 leading-relaxed max-w-xs mx-auto">
                    Send a message or bulk campaign from your desktop or another tab. Each SMS will
                    appear right here for one-tap dispatch through your SIM card.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {pendingJobs.map((job) => (
                    <article
                      key={job.jobId}
                      className="bg-white border border-blue-200 rounded-2xl p-4 space-y-3.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-mono tabular-nums text-sm font-bold text-slate-900">
                          {job.to}
                        </p>
                        <span className="text-[11px] font-mono uppercase text-blue-700 font-semibold">
                          {job.simSlot === 'auto' ? 'Auto SIM' : job.simSlot}
                        </span>
                      </div>

                      <p className="text-sm text-slate-800 bg-slate-50 border border-slate-200 rounded-xl p-3 whitespace-pre-wrap break-words">
                        {job.message}
                      </p>

                      <div className="space-y-2">
                        <a
                          href={buildSmsUri(job.to, job.message, handset.isIos)}
                          onClick={() => handleMarkSmsOpened(job.jobId)}
                          className="w-full min-h-[46px] px-4 py-2.5 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-sm font-semibold inline-flex items-center justify-center gap-2 transition-colors"
                        >
                          <ExternalLink className="w-4 h-4" />
                          1. Open in Phone SMS App
                        </a>

                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            onClick={() => handleReportJobResult(job, 'sent')}
                            className={`min-h-[44px] px-3 py-2 rounded-xl text-xs font-semibold inline-flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
                              job.openedInSmsApp
                                ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                                : 'border border-emerald-300 text-emerald-700 hover:bg-emerald-50'
                            }`}
                          >
                            <Check className="w-3.5 h-3.5" />
                            2. Confirm Sent
                          </button>

                          <button
                            type="button"
                            onClick={() => handleReportJobResult(job, 'failed')}
                            className="min-h-[44px] px-3 py-2 rounded-xl border border-red-200 text-red-600 hover:bg-red-50 text-xs font-semibold inline-flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                          >
                            <X className="w-3.5 h-3.5" />
                            Mark Failed
                          </button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>

            {/* Recent Dispatched History on Handset */}
            {recentJobs.length > 0 && (
              <section className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
                <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                  <h2 className="text-xs font-semibold text-slate-700">
                    Completed on This Phone ({recentJobs.length})
                  </h2>
                </div>
                <ul className="divide-y divide-slate-100">
                  {recentJobs.map((item) => (
                    <li
                      key={`${item.jobId}-${item.completedAt}`}
                      className="px-4 py-3 flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <p className="font-mono tabular-nums text-xs font-semibold text-slate-900 truncate">
                          {item.to}
                        </p>
                        <p className="text-xs text-slate-500 truncate">{item.message}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p
                          className={`text-xs font-semibold ${
                            item.status === 'sent' ? 'text-emerald-700' : 'text-red-600'
                          }`}
                        >
                          {item.status === 'sent' ? 'Sent' : 'Failed'}
                        </p>
                        <p className="text-[11px] font-mono tabular-nums text-slate-400">
                          {item.completedAt}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
