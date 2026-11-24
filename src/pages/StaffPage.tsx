import React, { useState } from 'react';
import {
  UserPlus,
  Trash2,
  ShieldCheck,
  X,
  CheckCircle2,
  AlertCircle,
  Ban,
  Check,
} from 'lucide-react';
import { deleteDoc, doc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { usePortalData } from '../context/PortalDataContext';
import {
  BOOTSTRAP_ADMIN_EMAIL,
  db,
  emailToStaffDocId,
  handleFirestoreError,
  OperationType,
  ORG_ID,
  recordAuditLog,
} from '../lib/firebase';
import { formatTimestamp } from '../lib/smsUtils';
import type { StaffAccount, UserRole } from '../types/portal';

export function StaffPage() {
  const { firebaseUser, role } = useAuth();
  const { staffAccounts } = usePortalData();

  const [modalOpen, setModalOpen] = useState(false);
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [staffRole, setStaffRole] = useState<UserRole>('staff');
  const [canSendBulk, setCanSendBulk] = useState(true);
  const [canManageContacts, setCanManageContacts] = useState(true);
  const [canManageCampaigns, setCanManageCampaigns] = useState(true);
  const [canViewReports, setCanViewReports] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  if (role !== 'admin') {
    return (
      <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center space-y-2">
        <p className="font-display font-bold text-slate-900">Administrator Access Only</p>
        <p className="text-xs text-slate-500">
          Only ZACMA Technology administrators can provision and manage staff accounts.
        </p>
      </div>
    );
  }

  const handleCreateStaff = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser?.email) return;
    setFeedback(null);

    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setFeedback({ type: 'error', text: 'Enter a valid Google email address for the staff member.' });
      return;
    }

    const docId = emailToStaffDocId(cleanEmail);
    setSaving(true);
    try {
      await setDoc(doc(db, 'staff_accounts', docId), {
        email: cleanEmail,
        fullName: fullName.trim().slice(0, 120),
        role: staffRole,
        status: 'active',
        canSendBulk: staffRole === 'admin' ? true : canSendBulk,
        canManageContacts: staffRole === 'admin' ? true : canManageContacts,
        canManageCampaigns: staffRole === 'admin' ? true : canManageCampaigns,
        canViewReports: staffRole === 'admin' ? true : canViewReports,
        orgId: ORG_ID,
        createdBy: firebaseUser.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      void recordAuditLog({
        action: 'STAFF_CREATED',
        actorUid: firebaseUser.uid,
        actorEmail: firebaseUser.email,
        actorRole: 'admin',
        targetType: 'staff_account',
        targetId: docId,
        summary: `Authorized ${fullName.trim()} (${cleanEmail}) as ${staffRole}`,
      });

      setFullName('');
      setEmail('');
      setStaffRole('staff');
      setModalOpen(false);
      setFeedback({
        type: 'success',
        text: `Staff account created for ${cleanEmail}. They can now sign in with Google.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `staff_accounts/${docId}`);
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (staff: StaffAccount) => {
    if (!firebaseUser?.email) return;
    const nextStatus = staff.status === 'active' ? 'suspended' : 'active';
    try {
      await updateDoc(doc(db, 'staff_accounts', staff.id), {
        status: nextStatus,
        updatedAt: serverTimestamp(),
      });
      void recordAuditLog({
        action: nextStatus === 'suspended' ? 'STAFF_SUSPENDED' : 'STAFF_ACTIVATED',
        actorUid: firebaseUser.uid,
        actorEmail: firebaseUser.email,
        actorRole: 'admin',
        targetType: 'staff_account',
        targetId: staff.id,
        summary: `Set ${staff.email} status to ${nextStatus}`,
      });
      setFeedback({ type: 'success', text: `${staff.fullName} is now ${nextStatus}.` });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `staff_accounts/${staff.id}`);
    }
  };

  const handleDeleteStaff = async (staff: StaffAccount) => {
    if (!firebaseUser?.email) return;
    try {
      await deleteDoc(doc(db, 'staff_accounts', staff.id));
      void recordAuditLog({
        action: 'STAFF_REVOKED',
        actorUid: firebaseUser.uid,
        actorEmail: firebaseUser.email,
        actorRole: 'admin',
        targetType: 'staff_account',
        targetId: staff.id,
        summary: `Revoked portal access for ${staff.email}`,
      });
      setFeedback({ type: 'success', text: `Revoked access for ${staff.email}.` });
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `staff_accounts/${staff.id}`);
    }
  };

  return (
    <div className="space-y-6">
      {feedback && (
        <div
          className={`rounded-2xl p-4 border flex items-center justify-between gap-3 text-sm ${
            feedback.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-red-50 border-red-200 text-red-700'
          }`}
        >
          <div className="flex items-center gap-2.5">
            {feedback.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 shrink-0" />
            )}
            <span>{feedback.text}</span>
          </div>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="p-1 rounded-lg hover:bg-black/5 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-base font-bold text-slate-900">
            Authorized Portal Accounts
          </h2>
          <p className="text-xs text-slate-500">
            Primary Owner: <span className="font-mono text-slate-700">{BOOTSTRAP_ADMIN_EMAIL}</span> ·
            Add staff Google accounts below to grant role-based access.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-xs sm:text-sm font-semibold px-4 cursor-pointer whitespace-nowrap shrink-0"
        >
          <UserPlus className="w-4 h-4" />
          Create Staff Account
        </button>
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        {staffAccounts.length === 0 ? (
          <div className="p-10 text-center space-y-2">
            <ShieldCheck className="w-8 h-8 text-blue-700 mx-auto" />
            <p className="font-display text-base font-bold text-slate-800">
              No additional staff accounts yet
            </p>
            <p className="text-xs text-slate-500 max-w-md mx-auto">
              Only authorized administrators and staff accounts listed here can access ZACMA SMS
              PORTAL or dispatch messages through SMS.io.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {staffAccounts.map((s) => (
              <div
                key={s.id}
                className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
              >
                <div className="space-y-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-sm text-slate-900">{s.fullName}</p>
                    <span className="text-slate-300">·</span>
                    <span className="text-xs font-semibold capitalize text-blue-700">{s.role}</span>
                    <span className="text-slate-300">·</span>
                    <span
                      className={`text-xs font-semibold capitalize ${
                        s.status === 'active' ? 'text-emerald-700' : 'text-red-600'
                      }`}
                    >
                      {s.status}
                    </span>
                  </div>
                  <p className="font-mono text-xs text-slate-600">{s.email}</p>
                  <p className="text-xs text-slate-500">
                    Permissions:{' '}
                    {[
                      s.canSendBulk && 'Send Bulk SMS',
                      s.canManageContacts && 'Manage Contacts',
                      s.canManageCampaigns && 'Manage Campaigns',
                      s.canViewReports && 'View Reports',
                    ]
                      .filter(Boolean)
                      .join(' · ') || 'View Only'}{' '}
                    · Added {formatTimestamp(s.createdAt)}
                  </p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => void toggleStatus(s)}
                    className={`min-h-[40px] inline-flex items-center gap-1.5 px-3 rounded-xl border text-xs font-semibold cursor-pointer ${
                      s.status === 'active'
                        ? 'border-amber-300 hover:bg-amber-50 text-amber-800'
                        : 'border-emerald-300 hover:bg-emerald-50 text-emerald-700'
                    }`}
                  >
                    {s.status === 'active' ? (
                      <>
                        <Ban className="w-3.5 h-3.5" />
                        Suspend
                      </>
                    ) : (
                      <>
                        <Check className="w-3.5 h-3.5" />
                        Activate
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDeleteStaff(s)}
                    className="min-h-[40px] min-w-[40px] inline-flex items-center justify-center rounded-xl border border-red-200 hover:bg-red-50 text-red-600 cursor-pointer"
                    aria-label={`Remove ${s.fullName}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create Staff Modal */}
      {modalOpen && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setModalOpen(false)}
        >
          <form
            onSubmit={(e) => void handleCreateStaff(e)}
            onClick={(e) => e.stopPropagation()}
            className="w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-2xl p-6 space-y-4 border border-slate-200"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-display text-lg font-bold text-slate-900">
                Create Staff Account
              </h3>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-slate-700">Full Name</label>
              <input
                type="text"
                required
                maxLength={120}
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="e.g. Tigist Alemu"
                className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-300 text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-slate-700">
                Google Account Email
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="staff@zacmatech.com"
                className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-300 font-mono text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-slate-700">Role</label>
              <select
                value={staffRole}
                onChange={(e) => setStaffRole(e.target.value as UserRole)}
                className="w-full min-h-[44px] px-3 rounded-xl border border-slate-300 text-sm bg-white"
              >
                <option value="staff">Staff Operator</option>
                <option value="admin">Administrator</option>
              </select>
            </div>

            {staffRole === 'staff' && (
              <div className="space-y-2 pt-1">
                <p className="text-xs font-semibold text-slate-700">Staff Permissions</p>
                <label className="flex items-center gap-2.5 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={canSendBulk}
                    onChange={(e) => setCanSendBulk(e.target.checked)}
                    className="w-4 h-4 accent-blue-700"
                  />
                  <span>Send Bulk SMS & Retry Failed Messages</span>
                </label>
                <label className="flex items-center gap-2.5 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={canManageContacts}
                    onChange={(e) => setCanManageContacts(e.target.checked)}
                    className="w-4 h-4 accent-blue-700"
                  />
                  <span>Add, Import, Edit & Deduplicate Contacts</span>
                </label>
                <label className="flex items-center gap-2.5 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={canManageCampaigns}
                    onChange={(e) => setCanManageCampaigns(e.target.checked)}
                    className="w-4 h-4 accent-blue-700"
                  />
                  <span>Schedule, Pause & Cancel Campaigns</span>
                </label>
                <label className="flex items-center gap-2.5 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={canViewReports}
                    onChange={(e) => setCanViewReports(e.target.checked)}
                    className="w-4 h-4 accent-blue-700"
                  />
                  <span>View SMS History & Export Reports</span>
                </label>
              </div>
            )}

            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="flex-1 min-h-[46px] rounded-xl border border-slate-300 text-sm font-semibold text-slate-700 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="flex-1 min-h-[46px] rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-sm font-semibold cursor-pointer disabled:opacity-50"
              >
                {saving ? 'Creating...' : 'Authorize Staff'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
