import { useEffect, useState } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  ShieldCheck,
  Smartphone,
  X,
} from 'lucide-react';

interface AndroidSetupGuideModalProps {
  open: boolean;
  onClose: () => void;
  shortPin?: string;
  wsUrl: string;
}

const MANIFEST_PERMISSIONS = `<uses-permission android:name="android.permission.SEND_SMS" />
<uses-permission android:name="android.permission.READ_PHONE_STATE" />
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />`;

const SETUP_STEPS = [
  {
    number: '01',
    shortLabel: 'Requirements',
    title: 'Prepare Your Android Phone & SIM Card',
    summary:
      'Before installing the companion app, verify that your Android device and mobile operator SIM are ready for bulk SMS traffic.',
    checklist: [
      {
        label: 'Android 8.0 (API 26) or newer',
        detail:
          'Required for Dual SIM subscription selection via SubscriptionManager and modern background foreground services.',
      },
      {
        label: 'Active SIM with SMS bundle or airtime',
        detail:
          'Insert your Ethio Telecom (09) or Safaricom (07) SIM card and confirm regular SMS sending works from the default Messages app.',
      },
      {
        label: 'Reliable Wi-Fi or mobile data connection',
        detail:
          'The companion app receives SMS dispatch jobs from ZACMA over an encrypted WebSocket connection before sending them over your cellular SIM.',
      },
    ],
  },
  {
    number: '02',
    shortLabel: 'Install App',
    title: 'Install the ZACMA Android Companion App',
    summary:
      'Web browsers cannot directly access your SIM radio. Install the ZACMA SIM Bridge companion app on your Android handset to relay SMS natively through Android SmsManager.',
    checklist: [
      {
        label: 'Allow installation on your Android handset',
        detail:
          'Open Settings → Apps → Special app access → Install unknown apps, select your browser or file manager, and toggle "Allow from this source" when installing the ZACMA internal APK.',
      },
      {
        label: 'Or build directly in Android Studio',
        detail:
          'If your IT team builds from source, add the AndroidManifest permissions below and paste the WebSocket + SmsManager Kotlin contract from the dashboard.',
      },
      {
        label: 'Verify Google Play Protect prompt',
        detail:
          'For internal enterprise APK installs, tap "More details → Install anyway" if Android displays an unrecognized developer notice.',
      },
    ],
  },
  {
    number: '03',
    shortLabel: 'SMS Permissions',
    title: 'Grant Required SMS & Dual SIM Permissions',
    summary:
      'Open Settings → Apps → ZACMA SIM Bridge → Permissions on your phone and allow the following permissions so messages dispatch reliably.',
    checklist: [
      {
        label: 'SMS (android.permission.SEND_SMS) — Required',
        detail:
          'Allows the companion app to transmit queued single and bulk messages natively through your phone’s SIM card and listen for sent/delivered broadcasts.',
      },
      {
        label: 'Phone (android.permission.READ_PHONE_STATE) — Required for Dual SIM',
        detail:
          'Lets the app read active SIM slots (SIM 1 and SIM 2), carrier names, and subscription IDs so you can switch SIMs directly from the ZACMA dashboard.',
      },
      {
        label: 'Notifications (POST_NOTIFICATIONS) — Android 13+',
        detail:
          'Keeps the foreground bridge status notification visible while your phone is actively connected and dispatching bulk campaigns.',
      },
    ],
  },
  {
    number: '04',
    shortLabel: 'Android 13+ Unlock',
    title: 'Enable Restricted Settings & Disable Battery Sleep',
    summary:
      'Android 13, 14, and 15 block SMS permissions on sideloaded apps by default and may pause background sockets during battery saving.',
    checklist: [
      {
        label: 'Allow restricted settings (Android 13+)',
        detail:
          'If the SMS toggle is greyed out, go to Settings → Apps → ZACMA SIM Bridge → tap the top-right three-dot menu (⋮) → select "Allow restricted settings", then return to Permissions and enable SMS.',
      },
      {
        label: 'Set Battery usage to Unrestricted',
        detail:
          'Open Settings → Apps → ZACMA SIM Bridge → Battery → choose "Unrestricted" so Android keeps your WebSocket bridge alive during large campaigns.',
      },
      {
        label: 'Keep screen or charger connected for large batches',
        detail:
          'For campaigns over 200 recipients, plug in the phone and keep mobile signal strong to avoid carrier rate throttling.',
      },
    ],
  },
  {
    number: '05',
    shortLabel: 'Scan & Verify',
    title: 'Scan the Dashboard QR Code & Send a Test SMS',
    summary:
      'Finish pairing by scanning the live QR code in the Connect Mobile Device panel to establish your encrypted WebSocket bridge.',
    checklist: [
      {
        label: 'Select your default SIM slot on the dashboard',
        detail:
          'Choose Auto SIM, SIM 1, or SIM 2 before scanning so your preferred operator line is pre-configured during pairing.',
      },
      {
        label: 'Tap "Scan QR to Link" in the Android app',
        detail:
          'Point your camera at the QR code (or enter the Pairing PIN shown under the QR). The single-use token automatically exchanges for a secure device credential.',
      },
      {
        label: 'Verify online status & send a Test SIM SMS',
        detail:
          'Your handset will immediately appear as Online under Linked Android Devices. Click "Test SIM SMS" to confirm live message delivery from your own phone number.',
      },
    ],
  },
] as const;

export function AndroidSetupGuideModal({
  open,
  onClose,
  shortPin,
  wsUrl,
}: AndroidSetupGuideModalProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [copiedManifest, setCopiedManifest] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const currentStep = SETUP_STEPS[stepIndex];
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === SETUP_STEPS.length - 1;

  const handleCopyManifest = async () => {
    try {
      await navigator.clipboard.writeText(MANIFEST_PERMISSIONS);
      setCopiedManifest(true);
      window.setTimeout(() => setCopiedManifest(false), 2000);
    } catch {
      // Ignore clipboard failure
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 sm:p-6 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="android-setup-modal-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl bg-white border border-slate-200 rounded-2xl shadow-xl overflow-hidden my-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="px-5 py-4 sm:px-6 sm:py-5 border-b border-slate-200 flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-700 flex items-center justify-center shrink-0">
              <Smartphone className="w-5 h-5" />
            </div>
            <div className="min-w-0 space-y-0.5">
              <h2
                id="android-setup-modal-title"
                className="font-display text-base sm:text-lg font-bold text-slate-900"
              >
                Android Companion Setup &amp; SMS Permissions
              </h2>
              <p className="text-xs text-slate-500 font-mono tabular-nums">
                Step {stepIndex + 1} of {SETUP_STEPS.length} · {currentStep.shortLabel}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="min-h-[40px] min-w-[40px] rounded-xl text-slate-500 hover:text-slate-900 hover:bg-slate-100 inline-flex items-center justify-center transition-colors cursor-pointer shrink-0"
            aria-label="Close setup guide"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Clickable Stepper Navigation */}
        <div className="px-5 py-3 sm:px-6 bg-slate-50 border-b border-slate-200 overflow-x-auto">
          <div className="flex items-center gap-1.5 min-w-max" role="tablist" aria-label="Setup steps">
            {SETUP_STEPS.map((step, idx) => {
              const active = idx === stepIndex;
              const completed = idx < stepIndex;
              return (
                <button
                  key={step.number}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setStepIndex(idx)}
                  className={`min-h-[36px] px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    active
                      ? 'bg-blue-700 text-white'
                      : completed
                        ? 'bg-white text-blue-700 border border-blue-200 hover:bg-blue-50'
                        : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
                  }`}
                >
                  <span className="font-mono tabular-nums">{step.number}.</span>
                  <span>{step.shortLabel}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Active Step Body */}
        <div className="px-5 py-5 sm:px-6 sm:py-6 space-y-5 max-h-[62vh] overflow-y-auto">
          <div className="space-y-1.5">
            <h3 className="font-display text-base font-bold text-slate-900">
              {currentStep.number}. {currentStep.title}
            </h3>
            <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
              {currentStep.summary}
            </p>
          </div>

          <ul className="divide-y divide-slate-100 border-t border-b border-slate-100">
            {currentStep.checklist.map((item) => (
              <li key={item.label} className="py-3.5 space-y-1">
                <p className="text-sm font-semibold text-slate-900">{item.label}</p>
                <p className="text-xs text-slate-600 leading-relaxed">{item.detail}</p>
              </li>
            ))}
          </ul>

          {/* Step 2 Extra: AndroidManifest.xml Permissions Snippet */}
          {stepIndex === 1 && (
            <div className="rounded-xl bg-slate-950 text-slate-100 p-4 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-200">
                  Required AndroidManifest.xml Permissions
                </span>
                <button
                  type="button"
                  onClick={() => void handleCopyManifest()}
                  className="min-h-[34px] px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
                >
                  {copiedManifest ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      Copy XML
                    </>
                  )}
                </button>
              </div>
              <pre className="text-[11px] leading-relaxed font-mono text-slate-300 overflow-x-auto whitespace-pre">
                {MANIFEST_PERMISSIONS}
              </pre>
            </div>
          )}

          {/* Step 3 Extra: Security & Privacy Reassurance */}
          {stepIndex === 2 && (
            <div className="rounded-xl bg-slate-50 border border-slate-200 p-4 flex items-start gap-3">
              <ShieldCheck className="w-5 h-5 text-blue-700 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-xs font-semibold text-slate-900">
                  Permissions stay strictly on your Android handset
                </p>
                <p className="text-xs text-slate-600 leading-relaxed">
                  ZACMA never requests inbox read access (<code className="font-mono text-slate-800">READ_SMS</code>) or contacts read access on your phone. Only outgoing <code className="font-mono text-slate-800">SEND_SMS</code> and SIM slot identification are required.
                </p>
              </div>
            </div>
          )}

          {/* Step 5 Extra: Current Pairing Session Quick Reference */}
          {stepIndex === 4 && (
            <div className="rounded-xl bg-slate-50 border border-slate-200 p-4 space-y-1.5 text-xs">
              <p className="font-semibold text-slate-900">Active Bridge Endpoint</p>
              <p className="font-mono text-slate-700 break-all">{wsUrl}</p>
              {shortPin && (
                <p className="text-slate-600 pt-1">
                  Current Pairing PIN:{' '}
                  <span className="font-mono tabular-nums font-semibold text-slate-900">
                    {shortPin}
                  </span>
                </p>
              )}
            </div>
          )}
        </div>

        {/* Modal Footer Navigation */}
        <div className="px-5 py-4 sm:px-6 border-t border-slate-200 bg-white flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
            disabled={isFirst}
            className="min-h-[42px] px-4 py-2 rounded-xl border border-slate-300 hover:bg-slate-50 text-xs font-semibold text-slate-800 inline-flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ChevronLeft className="w-4 h-4" />
            Previous
          </button>

          {isLast ? (
            <button
              type="button"
              onClick={() => {
                setStepIndex(0);
                onClose();
              }}
              className="min-h-[42px] px-5 py-2 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap"
            >
              <Check className="w-4 h-4" />
              Done — Ready to Scan QR
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setStepIndex((i) => Math.min(SETUP_STEPS.length - 1, i + 1))}
              className="min-h-[42px] px-5 py-2 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap"
            >
              Next Step
              <ChevronRight className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
