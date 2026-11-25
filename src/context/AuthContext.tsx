import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
  updateProfile,
  type User,
} from 'firebase/auth';
import { doc, getDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import {
  auth,
  BOOTSTRAP_ADMIN_EMAIL,
  db,
  emailToStaffDocId,
  formatFirebaseAuthError,
  googleProvider,
  handleFirestoreError,
  OperationType,
  recordAuditLog,
  type FormattedAuthError,
} from '../lib/firebase';
import type { StaffAccount, StaffPermissions, UserRole } from '../types/portal';

export interface AuthState {
  firebaseUser: User | null;
  loading: boolean;
  submitting: boolean;
  authorized: boolean;
  authStatus:
    | 'loading'
    | 'signed_out'
    | 'unverified_email'
    | 'authorized'
    | 'unauthorized'
    | 'suspended';
  role: UserRole;
  displayName: string;
  permissions: StaffPermissions;
  error: string | null;
  authError: FormattedAuthError | null;
  notice: string | null;
  clearFeedback: () => void;
  signInWithGoogle: () => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  registerWithEmail: (fullName: string, email: string, password: string) => Promise<void>;
  sendPasswordReset: (email: string) => Promise<boolean>;
  resendVerificationEmail: () => Promise<void>;
  refreshVerificationStatus: () => Promise<void>;
  signOut: () => Promise<void>;
  recheckAccess: () => Promise<void>;
}

const FULL_PERMISSIONS: StaffPermissions = {
  canSendBulk: true,
  canManageContacts: true,
  canManageCampaigns: true,
  canViewReports: true,
};

const NO_PERMISSIONS: StaffPermissions = {
  canSendBulk: false,
  canManageContacts: false,
  canManageCampaigns: false,
  canViewReports: false,
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [authStatus, setAuthStatus] = useState<AuthState['authStatus']>('loading');
  const [role, setRole] = useState<UserRole>('staff');
  const [displayName, setDisplayName] = useState('');
  const [permissions, setPermissions] = useState<StaffPermissions>(NO_PERMISSIONS);
  const [authError, setAuthError] = useState<FormattedAuthError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const clearFeedback = useCallback(() => {
    setAuthError(null);
    setNotice(null);
  }, []);

  const resolveUserAccess = useCallback(async (user: User | null) => {
    if (!user) {
      setFirebaseUser(null);
      setAuthStatus('signed_out');
      setRole('staff');
      setDisplayName('');
      setPermissions(NO_PERMISSIONS);
      setLoading(false);
      return;
    }

    setLoading(true);
    setFirebaseUser(user);

    const email = (user.email || '').trim().toLowerCase();
    if (!email) {
      setAuthStatus('unauthorized');
      setPermissions(NO_PERMISSIONS);
      setAuthError({
        code: 'auth/missing-email',
        message: 'Your account does not have an email address attached.',
        isUnauthorizedDomain: false,
        isProviderDisabled: false,
      });
      setLoading(false);
      return;
    }

    if (!user.emailVerified) {
      setAuthStatus('unverified_email');
      setDisplayName((user.displayName || email.split('@')[0] || 'Portal User').slice(0, 120));
      setPermissions(NO_PERMISSIONS);
      setLoading(false);
      return;
    }

    try {
      const isBootstrap = email === BOOTSTRAP_ADMIN_EMAIL.toLowerCase();
      let isAdmin = isBootstrap;
      let resolvedName = (user.displayName || email.split('@')[0] || 'Portal User').slice(0, 120);
      let resolvedPermissions: StaffPermissions = FULL_PERMISSIONS;
      let isActive = isBootstrap;
      let isSuspended = false;

      if (!isAdmin) {
        try {
          const adminSnap = await getDoc(doc(db, 'admins', user.uid));
          if (adminSnap.exists()) {
            isAdmin = true;
            isActive = true;
          }
        } catch {
          // Non-admin read denial handled gracefully below
        }
      }

      const staffDocId = emailToStaffDocId(email);
      let staffData: Omit<StaffAccount, 'id'> | null = null;
      try {
        const staffSnap = await getDoc(doc(db, 'staff_accounts', staffDocId));
        if (staffSnap.exists()) {
          staffData = staffSnap.data() as Omit<StaffAccount, 'id'>;
        }
      } catch {
        // Document absent or denied
      }

      if (staffData) {
        resolvedName = staffData.fullName || resolvedName;
        if (staffData.status === 'suspended' && !isBootstrap) {
          isSuspended = true;
          isActive = false;
        } else if (staffData.status === 'active') {
          isActive = true;
          if (staffData.role === 'admin') {
            isAdmin = true;
            resolvedPermissions = FULL_PERMISSIONS;
          } else {
            resolvedPermissions = {
              canSendBulk: staffData.canSendBulk,
              canManageContacts: staffData.canManageContacts,
              canManageCampaigns: staffData.canManageCampaigns,
              canViewReports: staffData.canViewReports,
            };
          }
        }
      }

      if (isSuspended) {
        setAuthStatus('suspended');
        setRole('staff');
        setDisplayName(resolvedName);
        setPermissions(NO_PERMISSIONS);
        setLoading(false);
        return;
      }

      if (!isActive) {
        setAuthStatus('unauthorized');
        setRole('staff');
        setDisplayName(resolvedName);
        setPermissions(NO_PERMISSIONS);
        setLoading(false);
        return;
      }

      const finalRole: UserRole = isAdmin ? 'admin' : 'staff';

      if (isBootstrap) {
        try {
          const adminDocRef = doc(db, 'admins', user.uid);
          const existingAdmin = await getDoc(adminDocRef);
          if (!existingAdmin.exists()) {
            await setDoc(adminDocRef, {
              uid: user.uid,
              email,
              grantedBy: user.uid,
              createdAt: serverTimestamp(),
            });
          }
        } catch {
          // Bootstrap email already grants full admin in security rules
        }
      }

      const userDocRef = doc(db, 'users', user.uid);
      try {
        const existingUser = await getDoc(userDocRef);
        if (!existingUser.exists()) {
          await setDoc(userDocRef, {
            uid: user.uid,
            email,
            displayName: resolvedName,
            role: finalRole,
            status: 'active',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } else {
          await updateDoc(userDocRef, {
            displayName: resolvedName,
            updatedAt: serverTimestamp(),
          });
        }
      } catch (profileErr) {
        console.warn('Profile sync notice:', profileErr);
      }

      setRole(finalRole);
      setDisplayName(resolvedName);
      setPermissions(isAdmin ? FULL_PERMISSIONS : resolvedPermissions);
      setAuthStatus('authorized');
      setAuthError(null);
      setNotice(null);
      setLoading(false);

      void recordAuditLog({
        action: 'AUTH_LOGIN',
        actorUid: user.uid,
        actorEmail: email,
        actorRole: finalRole,
        targetType: 'session',
        targetId: user.uid,
        summary: `${resolvedName} (${finalRole}) signed in to ZACMA SMS PORTAL`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, 'users');
    }
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      void resolveUserAccess(user);
    });
    return unsub;
  }, [resolveUserAccess]);

  const signInWithGoogle = useCallback(async () => {
    setAuthError(null);
    setNotice(null);
    setSubmitting(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      const formatted = formatFirebaseAuthError(err);
      if (formatted.message) {
        setAuthError(formatted);
      }
    } finally {
      setSubmitting(false);
    }
  }, []);

  const signInWithEmail = useCallback(async (email: string, password: string) => {
    setAuthError(null);
    setNotice(null);
    setSubmitting(true);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch (err) {
      const formatted = formatFirebaseAuthError(err);
      if (formatted.message) {
        setAuthError(formatted);
      }
    } finally {
      setSubmitting(false);
    }
  }, []);

  const registerWithEmail = useCallback(
    async (fullName: string, email: string, password: string) => {
      setAuthError(null);
      setNotice(null);
      setSubmitting(true);
      try {
        const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
        if (fullName.trim()) {
          await updateProfile(cred.user, { displayName: fullName.trim().slice(0, 120) });
        }
        await sendEmailVerification(cred.user);
        setNotice(
          `Account created. A verification link was sent to ${email.trim()}. Verify your email, then click "I've Verified — Continue".`
        );
      } catch (err) {
        const formatted = formatFirebaseAuthError(err);
        if (formatted.message) {
          setAuthError(formatted);
        }
      } finally {
        setSubmitting(false);
      }
    },
    []
  );

  const sendPasswordReset = useCallback(async (email: string): Promise<boolean> => {
    setAuthError(null);
    setNotice(null);
    const cleanEmail = email.trim();
    if (!cleanEmail) {
      setAuthError({
        code: 'auth/invalid-email',
        message: 'Enter your email address to receive a password reset link.',
        isUnauthorizedDomain: false,
        isProviderDisabled: false,
      });
      return false;
    }
    setSubmitting(true);
    try {
      await sendPasswordResetEmail(auth, cleanEmail);
      setNotice(`Password reset instructions have been sent to ${cleanEmail}. Check your inbox.`);
      return true;
    } catch (err) {
      const formatted = formatFirebaseAuthError(err);
      if (formatted.message) {
        setAuthError(formatted);
      }
      return false;
    } finally {
      setSubmitting(false);
    }
  }, []);

  const resendVerificationEmail = useCallback(async () => {
    setAuthError(null);
    setNotice(null);
    const user = auth.currentUser;
    if (!user) return;
    setSubmitting(true);
    try {
      await sendEmailVerification(user);
      setNotice(`Verification link re-sent to ${user.email}. Check your inbox and spam folder.`);
    } catch (err) {
      const formatted = formatFirebaseAuthError(err);
      if (formatted.message) {
        setAuthError(formatted);
      }
    } finally {
      setSubmitting(false);
    }
  }, []);

  const refreshVerificationStatus = useCallback(async () => {
    setAuthError(null);
    setNotice(null);
    const user = auth.currentUser;
    if (!user) return;
    setSubmitting(true);
    try {
      await user.reload();
      await user.getIdToken(true);
      if (!auth.currentUser?.emailVerified) {
        setNotice('Email is not verified yet. Open the verification link in your inbox, then click again.');
      }
      await resolveUserAccess(auth.currentUser);
    } catch (err) {
      const formatted = formatFirebaseAuthError(err);
      if (formatted.message) {
        setAuthError(formatted);
      }
    } finally {
      setSubmitting(false);
    }
  }, [resolveUserAccess]);

  const signOut = useCallback(async () => {
    setAuthError(null);
    setNotice(null);
    await firebaseSignOut(auth);
  }, []);

  const recheckAccess = useCallback(async () => {
    await resolveUserAccess(auth.currentUser);
  }, [resolveUserAccess]);

  return (
    <AuthContext.Provider
      value={{
        firebaseUser,
        loading,
        submitting,
        authorized: authStatus === 'authorized',
        authStatus,
        role,
        displayName,
        permissions,
        error: authError?.message || null,
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
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
