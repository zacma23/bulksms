import { ShieldAlert, ShieldCheck, RefreshCw, LogOut } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { ZacmaBrandMark } from '../components/ZacmaBrandMark';

export function LoginPage() {
  const { authStatus, firebaseUser, error, signInWithGoogle, signOut, recheckAccess } = useAuth();

  if (authStatus === 'unauthorized' || authStatus === 'suspended') {
    const isSuspended = authStatus === 'suspended';
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 space-y-6">
          <div className="flex items-center gap-3">
            <ZacmaBrandMark size={38} />
            <div>
              <p className="font-display font-bold text-slate-900 leading-tight">ZACMA SMS PORTAL</p>
              <p className="text-xs text-slate-500">ZACMA Technology</p>
            </div>
          </div>

          <div className="p-4 rounded-xl bg-red-50 border border-red-200 space-y-2">
            <div className="flex items-center gap-2 text-red-700 font-semibold text-sm">
              <ShieldAlert className="w-4 h-4 shrink-0" />
              <span>{isSuspended ? 'Account Suspended' : 'Administrator Approval Required'}</span>
            </div>
            <p className="text-xs text-red-800 leading-relaxed">
              {isSuspended
                ? `The account ${firebaseUser?.email} has been suspended by a ZACMA Technology administrator.`
                : `Signed in as ${firebaseUser?.email}, which is not yet authorized in ZACMA SMS PORTAL. Ask your administrator to add this Google email under Staff & Roles.`}
            </p>
          </div>

          {error && <p className="text-xs text-red-600">{error}</p>}

          <div className="flex flex-col sm:flex-row gap-3">
            <button
              type="button"
              onClick={() => void recheckAccess()}
              className="flex-1 min-h-[46px] inline-flex items-center justify-center gap-2 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-sm font-semibold px-4 transition-colors cursor-pointer"
            >
              <RefreshCw className="w-4 h-4" />
              Recheck Access
            </button>
            <button
              type="button"
              onClick={() => void signOut()}
              className="flex-1 min-h-[46px] inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 hover:bg-slate-100 text-slate-700 text-sm font-semibold px-4 transition-colors cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
              Switch Account
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col lg:flex-row">
      {/* Left Brand Column */}
      <div className="lg:w-1/2 bg-slate-950 text-white p-8 sm:p-12 lg:p-16 flex flex-col justify-between">
        <div className="flex items-center gap-3">
          <ZacmaBrandMark size={40} />
          <span className="font-display font-bold text-lg tracking-tight text-white">
            ZACMA TECHNOLOGY
          </span>
        </div>

        <div className="my-10 lg:my-0 max-w-lg space-y-5">
          <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight text-white leading-tight [text-wrap:balance]">
            ZACMA SMS PORTAL
          </h1>
          <p className="text-slate-300 text-sm sm:text-base leading-relaxed">
            Enterprise Bulk SMS command center for Ethiopian (+251) and international messaging.
            Manage customer contact groups, schedule personalized campaigns, and track live SMS.io
            delivery reports from mobile or desktop.
          </p>

          <div className="pt-4 border-t border-slate-800 grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs text-slate-300">
            <div>
              <p className="font-semibold text-white">Ethiopian +251 Ready</p>
              <p className="text-slate-400 mt-0.5">Ethio Telecom, Safaricom & global E.164</p>
            </div>
            <div>
              <p className="font-semibold text-white">Excel & CSV Import</p>
              <p className="text-slate-400 mt-0.5">Auto-deduplication & group targeting</p>
            </div>
            <div>
              <p className="font-semibold text-white">Role-Based Access</p>
              <p className="text-slate-400 mt-0.5">Admin controls & immutable audit trail</p>
            </div>
          </div>
        </div>

        <p className="text-xs text-slate-500">
          © {new Date().getFullYear()} ZACMA Technology · Powered by SMS.io API
        </p>
      </div>

      {/* Right Sign-In Column */}
      <div className="lg:w-1/2 flex items-center justify-center p-6 sm:p-12">
        <div className="w-full max-w-md bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 space-y-6">
          <div className="space-y-1.5">
            <h2 className="font-display text-2xl font-bold text-slate-900">Portal Sign In</h2>
            <p className="text-sm text-slate-600">
              Authenticate with your authorized ZACMA Technology Google account to continue.
            </p>
          </div>

          {error && (
            <div className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700">
              {error}
            </div>
          )}

          <button
            type="button"
            onClick={() => void signInWithGoogle()}
            className="w-full min-h-[50px] inline-flex items-center justify-center gap-3 rounded-xl bg-blue-700 hover:bg-blue-800 active:scale-[0.99] text-white text-sm font-semibold px-5 py-3 transition-all cursor-pointer"
          >
            <svg className="w-5 h-5 bg-white rounded-full p-0.5" viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="#4285F4"
                d="M23.745 12.27c0-.79-.07-1.54-.19-2.27h-11.3v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"
              />
              <path
                fill="#34A853"
                d="M12.255 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96h-3.98v3.09C3.515 21.3 7.565 24 12.255 24z"
              />
              <path
                fill="#FBBC05"
                d="M5.525 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62h-3.98a11.86 11.86 0 000 10.76l3.98-3.09z"
              />
              <path
                fill="#EA4335"
                d="M12.255 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C18.205 1.19 15.495 0 12.255 0c-4.69 0-8.74 2.7-10.71 6.62l3.98 3.09c.95-2.85 3.6-4.96 6.73-4.96z"
              />
            </svg>
            <span>Sign in with Google</span>
          </button>

          <div className="pt-4 border-t border-slate-100 flex items-start gap-2.5 text-xs text-slate-500">
            <ShieldCheck className="w-4 h-4 text-blue-700 shrink-0 mt-0.5" />
            <p className="leading-relaxed">
              Protected by Firebase Authentication, role-based Firestore rules, and server-side
              SMS.io API key isolation.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
