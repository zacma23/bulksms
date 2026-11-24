import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut as firebaseSignOut, type User } from 'firebase/auth';
import { doc, getDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import {
  auth,
  BOOTSTRAP_ADMIN_EMAIL,
  db,
  emailToStaffDocId,
  googleProvider,
  handleFirestoreError,
  OperationType,
  recordAuditLog,
} from '../lib/firebase';
import type { StaffAccount, StaffPermissions, UserRole } from '../types/portal';

export interface AuthState {
  firebaseUser: User | null;
  loading: boolean;
  authorized: boolean;
  authStatus: 'loading' | 'signed_out' | 'authorized' | 'unauthorized' | 'suspended';
  role: UserRole;
  displayName: string;
  permissions: StaffPermissions;
  error: string | null;
  signInWithGoogle: () => Promise<void>;
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
  const [authStatus, setAuthStatus] = useState<AuthState['authStatus']>('loading');
  const [role, setRole] = useState<UserRole>('staff');
  const [displayName, setDisplayName] = useState('');
  const [permissions, setPermissions] = useState<StaffPermissions>(NO_PERMISSIONS);
  const [error, setError] = useState<string | null>(null);

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
    setError(null);
    setFirebaseUser(user);

    const email = (user.email || '').trim().toLowerCase();
    if (!email || !user.emailVerified) {
      setAuthStatus('unauthorized');
      setPermissions(NO_PERMISSIONS);
      setError('A verified Google email address is required to access ZACMA SMS PORTAL.');
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

      // Check admins/{uid} registry if not bootstrap admin
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

      // Check admin-created staff_accounts/{emailKey}
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

      // Ensure bootstrap admin or promoted staff-admin has /admins/{uid} doc if allowed
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

      // Sync /users/{uid} profile
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
        // Surface rule issues only if unexpected
        console.warn('Profile sync notice:', profileErr);
      }

      setRole(finalRole);
      setDisplayName(resolvedName);
      setPermissions(isAdmin ? FULL_PERMISSIONS : resolvedPermissions);
      setAuthStatus('authorized');
      setLoading(false);

      // Record sign-in audit event
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
    setError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sign-in failed. Please try again.';
      if (!msg.includes('popup-closed-by-user')) {
        setError(msg);
      }
    }
  }, []);

  const signOut = useCallback(async () => {
    setError(null);
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
        authorized: authStatus === 'authorized',
        authStatus,
        role,
        displayName,
        permissions,
        error,
        signInWithGoogle,
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
