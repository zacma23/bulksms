import React, { useState } from 'react';
import {
  ShieldAlert,
  ShieldCheck,
  RefreshCw,
  LogOut,
  MailCheck,
  Copy,
  Check,
  KeyRound,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { FIREBASE_AUTH_SETTINGS } from '../lib/firebase';
import { ZacmaBrandMark } from '../components/ZacmaBrandMark';

type AuthMode = 'signin' | 'register' | 'reset';

export function LoginPage() {
  const {
    authStatus,
    firebaseUser,
    submitting,
    error,
    authError,
    notice,
    clearFeedback,
    signInWithGoogle,
    signInWithEmail,
    registerWithEmail,
    sendPasswordReset,
    resendVerificationEmail,
    refreshVerificationStatus,
    signOut,
    recheckAccess,
  } = useAuth();

  const [mode, setMode] = useState<AuthMode>('signin');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [copiedHost, setCopiedHost] = useState(false);

  const switchMode = (next: AuthMode) => {
    setMode(next);
    clearFeedback();
  };

  const handleCopyHostname = async () => {
    try {
      await navigator.clipboard.writeText(FIREBASE_AUTH_SETTINGS.currentHostname);
      setCopiedHost(true);
      setTimeout(() => setCopiedHost(false), 2000);
    } catch {
      // Clipboard blocked in restricted context
    }
  };

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === 'signin') {
      await signInWithEmail(email, password);
    } else if (mode === 'register') {
      await registerWithEmail(fullName, email, password);
    } else {
      await sendPasswordReset(email);
    }
  };

  if (authStatus === 'unverified_email') {
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

          <div className="p-4 rounded-xl bg-blue-50 border border-blue-200 space-y-2">
            <div className="flex items-center gap-2 text-blue-800 font-semibold text-sm">
              <MailCheck className="w-4 h-4 shrink-0" />
              <span>Verify Your Email Address</span>
            </div>
            <p className="text-xs text-blue-900 leading-relaxed">
              Signed in as <span className="font-mono">{firebaseUser?.email}</span>. For security,
              ZACMA SMS PORTAL requires a verified email before accessing contacts or SMS gateways.
              Open the verification link in your inbox, then continue below.
            </p>
          </div>

          {notice && (
            <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-800">
              {notice}
            </div>
          )}
          {error && (
            <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700">
              {error}
            </div>
          )}

          <div className="space-y-2.5">
            <button
              type="button"
              disabled={submitting}
              onClick={() => void refreshVerificationStatus()}
              className="w-full min-h-[46px] inline-flex items-center justify-center gap-2 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-sm font-semibold px-4 transition-colors cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${submitting ? 'animate-spin' : ''}`} />
              I&apos;ve Verified — Continue
            </button>
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                disabled={submitting}
                onClick={() => void resendVerificationEmail()}
                className="min-h-[44px] rounded-xl border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-semibold px-3 cursor-pointer disabled:opacity-50"
              >
                Resend Email
              </button>
              <button
                type="button"
                onClick={() => void signOut()}
                className="min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-semibold px-3 cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5" />
                Switch Account
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

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
                : `Signed in as ${firebaseUser?.email}, which is not yet authorized in ZACMA SMS PORTAL. Ask your administrator to add this email under Staff & Roles.`}
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
        <div className="w-full max-w-md bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 space-y-5">
          <div className="space-y-1">
            <h2 className="font-display text-2xl font-bold text-slate-900">
              {mode === 'signin'
                ? 'Portal Sign In'
                : mode === 'register'
                  ? 'Create Staff Account'
                  : 'Reset Password'}
            </h2>
            <p className="text-sm text-slate-600">
              {mode === 'signin'
                ? 'Sign in with Google or your authorized ZACMA Technology email.'
                : mode === 'register'
                  ? 'Register with your admin-approved email address.'
                  : 'Enter your email address to receive a Firebase password reset link.'}
            </p>
          </div>

          {/* Mode Tabs */}
          <div className="grid grid-cols-3 gap-1 p-1 bg-slate-100 rounded-xl">
            {(
              [
                ['signin', 'Sign In'],
                ['register', 'Register'],
                ['reset', 'Reset'],
              ] as Array<[AuthMode, string]>
            ).map(([m, label]) => (
              <button
                key={m}
                type="button"
                onClick={() => switchMode(m)}
                className={`min-h-[38px] rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                  mode === m
                    ? 'bg-white text-blue-700 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {notice && (
            <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 leading-relaxed">
              {notice}
            </div>
          )}

          {error && (
            <div className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700 space-y-2.5 leading-relaxed">
              <p>{error}</p>
              {authError?.isUnauthorizedDomain && (
                <div className="pt-2 border-t border-red-200/80 space-y-2">
                  <div className="flex items-center justify-between gap-2 bg-white border border-red-200 rounded-lg px-2.5 py-1.5">
                    <code className="font-mono text-[11px] text-slate-900 truncate">
                      {FIREBASE_AUTH_SETTINGS.currentHostname}
                    </code>
                    <button
                      type="button"
                      onClick={() => void handleCopyHostname()}
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-700 hover:text-blue-800 shrink-0 cursor-pointer"
                    >
                      {copiedHost ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      {copiedHost ? 'Copied' : 'Copy Domain'}
                    </button>
                  </div>
                  <p className="text-[11px] text-red-800">
                    Firebase Console ({FIREBASE_AUTH_SETTINGS.projectId}) → Authentication →
                    Settings → Authorized domains → Add domain.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Google Sign-In */}
          {mode !== 'reset' && (
            <>
              <button
                type="button"
                disabled={submitting}
                onClick={() => void signInWithGoogle()}
                className="w-full min-h-[48px] inline-flex items-center justify-center gap-3 rounded-xl bg-blue-700 hover:bg-blue-800 active:scale-[0.99] text-white text-sm font-semibold px-5 py-3 transition-all cursor-pointer disabled:opacity-50"
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
                <span>{submitting ? 'Signing in...' : 'Continue with Google'}</span>
              </button>

              <div className="relative flex items-center py-1">
                <div className="flex-grow border-t border-slate-200" />
                <span className="shrink mx-3 text-xs text-slate-400">or with email &amp; password</span>
                <div className="flex-grow border-t border-slate-200" />
              </div>
            </>
          )}

          {/* Email / Password Form */}
          <form onSubmit={(e) => void handleEmailSubmit(e)} className="space-y-3.5">
            {mode === 'register' && (
              <div className="space-y-1">
                <label htmlFor="auth-name" className="block text-xs font-semibold text-slate-700">
                  Full Name
                </label>
                <input
                  id="auth-name"
                  type="text"
                  required
                  maxLength={120}
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="e.g. Zekarias Muluken"
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-300 text-sm text-slate-900 focus:border-blue-600"
                />
              </div>
            )}

            <div className="space-y-1">
              <label htmlFor="auth-email" className="block text-xs font-semibold text-slate-700">
                Email Address
              </label>
              <input
                id="auth-email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@zacmatech.com"
                className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-300 text-sm text-slate-900 focus:border-blue-600"
              />
            </div>

            {mode !== 'reset' && (
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label htmlFor="auth-password" className="block text-xs font-semibold text-slate-700">
                    Password
                  </label>
                  {mode === 'signin' && (
                    <button
                      type="button"
                      onClick={() => switchMode('reset')}
                      className="text-xs font-semibold text-blue-700 hover:text-blue-800 cursor-pointer"
                    >
                      Forgot password?
                    </button>
                  )}
                </div>
                <input
                  id="auth-password"
                  type="password"
                  required
                  minLength={6}
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-300 text-sm text-slate-900 focus:border-blue-600"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full min-h-[46px] inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-sm font-semibold px-4 transition-colors cursor-pointer disabled:opacity-50"
            >
              {mode === 'reset' && <KeyRound className="w-4 h-4" />}
              <span>
                {submitting
                  ? 'Please wait...'
                  : mode === 'signin'
                    ? 'Sign In with Email'
                    : mode === 'register'
                      ? 'Create Account'
                      : 'Send Reset Link'}
              </span>
            </button>
          </form>

          <div className="pt-3 border-t border-slate-100 flex items-start gap-2.5 text-xs text-slate-500">
            <ShieldCheck className="w-4 h-4 text-blue-700 shrink-0 mt-0.5" />
            <p className="leading-relaxed">
              Protected by Firebase Authentication, persistent local sessions, role-based Firestore
              rules, and server-side SMS.io API key isolation.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
