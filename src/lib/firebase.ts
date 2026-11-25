import { initializeApp } from 'firebase/app';
import {
  browserLocalPersistence,
  GoogleAuthProvider,
  getAuth,
  setPersistence,
} from 'firebase/auth';
import {
  addDoc,
  collection,
  doc,
  getDocFromServer,
  getFirestore,
  serverTimestamp,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import type { UserRole } from '../types/portal';

const currentHostname =
  typeof window !== 'undefined' && window.location?.hostname
    ? window.location.hostname.toLowerCase()
    : 'localhost';

const envAuthDomain = (import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || '').trim();
const resolvedAuthDomain = envAuthDomain || firebaseConfig.authDomain;

const extraEnvDomains = (import.meta.env.VITE_FIREBASE_AUTHORIZED_DOMAINS || '')
  .split(',')
  .map((d: string) => d.trim().toLowerCase())
  .filter(Boolean);

// Client-side domain registry tracking all expected hosting domains (localhost, Vercel, AI Studio, Firebase)
// Note: Firebase enforces OAuth authorizedDomains server-side in Firebase Console -> Authentication -> Settings -> Authorized domains.
export const FIREBASE_AUTH_SETTINGS = {
  projectId: firebaseConfig.projectId,
  authDomain: resolvedAuthDomain,
  oAuthClientId: firebaseConfig.oAuthClientId,
  currentHostname,
  authorizedDomains: Array.from(
    new Set([
      'localhost',
      '127.0.0.1',
      firebaseConfig.authDomain,
      `${firebaseConfig.projectId}.web.app`,
      currentHostname,
      ...extraEnvDomains,
    ])
  ),
  consoleAuthorizedDomainsUrl: `https://console.firebase.google.com/project/${firebaseConfig.projectId}/authentication/settings`,
  consoleProvidersUrl: `https://console.firebase.google.com/project/${firebaseConfig.projectId}/authentication/providers`,
};

const appConfig = {
  apiKey: firebaseConfig.apiKey,
  authDomain: resolvedAuthDomain,
  projectId: firebaseConfig.projectId,
  storageBucket: firebaseConfig.storageBucket,
  messagingSenderId: firebaseConfig.messagingSenderId,
  appId: firebaseConfig.appId,
  ...(firebaseConfig.measurementId ? { measurementId: firebaseConfig.measurementId } : {}),
  authorizedDomains: FIREBASE_AUTH_SETTINGS.authorizedDomains,
};

const app = initializeApp(appConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

// Keep users signed in across browser reloads and tab restarts
void setPersistence(auth, browserLocalPersistence).catch((err) => {
  console.warn('Could not enforce browserLocalPersistence:', err);
});

export const googleProvider = new GoogleAuthProvider();
googleProvider.addScope('email');
googleProvider.addScope('profile');
googleProvider.setCustomParameters({ prompt: 'select_account' });

export const BOOTSTRAP_ADMIN_EMAIL = 'zekimuluken@gmail.com';
export const ORG_ID = 'zacma' as const;

export interface FormattedAuthError {
  code: string;
  message: string;
  isUnauthorizedDomain: boolean;
  isProviderDisabled: boolean;
}

export function formatFirebaseAuthError(error: unknown): FormattedAuthError {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code || '')
      : '';
  const rawMessage = error instanceof Error ? error.message : String(error || '');

  if (code === 'auth/unauthorized-domain' || rawMessage.includes('auth/unauthorized-domain')) {
    return {
      code: 'auth/unauthorized-domain',
      message: `This domain (${FIREBASE_AUTH_SETTINGS.currentHostname}) is not whitelisted in Firebase Console yet. Add "${FIREBASE_AUTH_SETTINGS.currentHostname}" under Authentication → Settings → Authorized domains for project "${FIREBASE_AUTH_SETTINGS.projectId}", or sign in with Email & Password below.`,
      isUnauthorizedDomain: true,
      isProviderDisabled: false,
    };
  }

  if (code === 'auth/operation-not-allowed') {
    return {
      code,
      message:
        'This sign-in method is not enabled yet in Firebase Console. Enable Email/Password under Authentication → Sign-in method.',
      isUnauthorizedDomain: false,
      isProviderDisabled: true,
    };
  }

  if (code === 'auth/popup-blocked') {
    return {
      code,
      message:
        'Your browser blocked the Google sign-in popup. Allow popups for this site or sign in with Email & Password.',
      isUnauthorizedDomain: false,
      isProviderDisabled: false,
    };
  }

  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
    return {
      code,
      message: '',
      isUnauthorizedDomain: false,
      isProviderDisabled: false,
    };
  }

  if (
    code === 'auth/invalid-credential' ||
    code === 'auth/wrong-password' ||
    code === 'auth/user-not-found'
  ) {
    return {
      code,
      message: 'Invalid email or password. Double-check your credentials or reset your password.',
      isUnauthorizedDomain: false,
      isProviderDisabled: false,
    };
  }

  if (code === 'auth/email-already-in-use') {
    return {
      code,
      message: 'An account with this email already exists. Please sign in or reset your password.',
      isUnauthorizedDomain: false,
      isProviderDisabled: false,
    };
  }

  if (code === 'auth/weak-password') {
    return {
      code,
      message: 'Password is too weak. Use at least 6 characters with letters and numbers.',
      isUnauthorizedDomain: false,
      isProviderDisabled: false,
    };
  }

  if (code === 'auth/invalid-email') {
    return {
      code,
      message: 'Please enter a valid email address.',
      isUnauthorizedDomain: false,
      isProviderDisabled: false,
    };
  }

  if (code === 'auth/too-many-requests') {
    return {
      code,
      message: 'Too many sign-in attempts. Wait a minute and try again, or reset your password.',
      isUnauthorizedDomain: false,
      isProviderDisabled: false,
    };
  }

  if (code === 'auth/network-request-failed') {
    return {
      code,
      message: 'Network error contacting Firebase Authentication. Check your internet connection.',
      isUnauthorizedDomain: false,
      isProviderDisabled: false,
    };
  }

  return {
    code: code || 'auth/unknown',
    message: rawMessage || 'Authentication failed. Please try again.',
    isUnauthorizedDomain: false,
    isProviderDisabled: false,
  };
}

export function emailToStaffDocId(email: string): string {
  return email
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .slice(0, 128);
}

export function generateSafeId(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '')
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}_${rand}`.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120);
}

// Startup connectivity verification per Firebase integration guidelines
async function testConnection(): Promise<void> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration. Firestore client is offline.');
    }
  }
}
void testConnection();

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function recordAuditLog(params: {
  action: string;
  actorUid: string;
  actorEmail: string;
  actorRole: UserRole;
  targetType: string;
  targetId: string;
  summary: string;
}): Promise<void> {
  try {
    await addDoc(collection(db, 'audit_logs'), {
      action: params.action.slice(0, 80),
      actorUid: params.actorUid,
      actorEmail: params.actorEmail,
      actorRole: params.actorRole,
      targetType: params.targetType.slice(0, 60),
      targetId: params.targetId.slice(0, 128),
      summary: params.summary.slice(0, 500),
      orgId: ORG_ID,
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    console.error('Audit log write failed:', error);
  }
}
