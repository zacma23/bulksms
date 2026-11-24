import React, { useMemo, useRef, useState } from 'react';
import {
  Plus,
  Upload,
  Download,
  Search,
  Trash2,
  Edit3,
  FolderPlus,
  Sparkles,
  X,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import {
  deleteDoc,
  doc,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { usePortalData } from '../context/PortalDataContext';
import {
  db,
  generateSafeId,
  handleFirestoreError,
  OperationType,
  ORG_ID,
  recordAuditLog,
} from '../lib/firebase';
import {
  detectCarrierLabel,
  exportRowsToCsv,
  exportRowsToExcel,
  isValidE164Phone,
  normalizePhoneNumber,
  parseContactsSpreadsheet,
  type ParsedImportContact,
} from '../lib/smsUtils';
import type { Contact, ContactGroup } from '../types/portal';

export function ContactsPage() {
  const { firebaseUser, role, permissions } = useAuth();
  const { groups, contacts } = usePortalData();

  const [selectedGroupId, setSelectedGroupId] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Add/Edit Contact modal
  const [contactModalOpen, setContactModalOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [cName, setCName] = useState('');
  const [cPhone, setCPhone] = useState('');
  const [cNotes, setCNotes] = useState('');
  const [cGroupIds, setCGroupIds] = useState<string[]>([]);
  const [savingContact, setSavingContact] = useState(false);

  // Group modal
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<ContactGroup | null>(null);
  const [gName, setGName] = useState('');
  const [gDesc, setGDesc] = useState('');
  const [savingGroup, setSavingGroup] = useState(false);

  // Import Excel/CSV modal
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importRows, setImportRows] = useState<ParsedImportContact[]>([]);
  const [importGroupId, setImportGroupId] = useState<string>('');
  const [importDefaultEth, setImportDefaultEth] = useState(true);
  const [importing, setImporting] = useState(false);
  const importFileRef = useRef<HTMLInputElement>(null);

  // Deduplication state
  const [deduplicating, setDeduplicating] = useState(false);

  const duplicateCount = useMemo(() => {
    const seen = new Set<string>();
    let dups = 0;
    for (const c of contacts) {
      if (seen.has(c.phone)) dups += 1;
      else seen.add(c.phone);
    }
    return dups;
  }, [contacts]);

  const filteredContacts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return contacts.filter((c) => {
      if (selectedGroupId !== 'all' && !c.groupIds.includes(selectedGroupId)) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        c.phone.toLowerCase().includes(q) ||
        c.notes.toLowerCase().includes(q)
      );
    });
  }, [contacts, selectedGroupId, searchQuery]);

  const groupNameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of groups) m.set(g.id, g.name);
    return m;
  }, [groups]);

  const openAddContact = () => {
    setEditingContact(null);
    setCName('');
    setCPhone('+251');
    setCNotes('');
    setCGroupIds(selectedGroupId !== 'all' ? [selectedGroupId] : []);
    setContactModalOpen(true);
  };

  const openEditContact = (c: Contact) => {
    setEditingContact(c);
    setCName(c.name);
    setCPhone(c.phone);
    setCNotes(c.notes || '');
    setCGroupIds(c.groupIds || []);
    setContactModalOpen(true);
  };

  const handleSaveContact = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser?.email || !permissions.canManageContacts) return;
    setFeedback(null);

    const normalized = normalizePhoneNumber(cPhone, true);
    if (!isValidE164Phone(normalized)) {
      setFeedback({
        type: 'error',
        text: 'Please enter a valid Ethiopian (+251) or international phone number.',
      });
      return;
    }
    if (!cName.trim()) {
      setFeedback({ type: 'error', text: 'Contact name is required.' });
      return;
    }

    setSavingContact(true);
    try {
      if (editingContact) {
        await updateDoc(doc(db, 'contacts', editingContact.id), {
          name: cName.trim().slice(0, 120),
          phone: normalized,
          groupIds: cGroupIds.slice(0, 20),
          notes: cNotes.trim().slice(0, 300),
          updatedAt: serverTimestamp(),
        });
        setFeedback({ type: 'success', text: `Updated contact ${cName.trim()}.` });
      } else {
        const id = generateSafeId('cnt');
        await setDoc(doc(db, 'contacts', id), {
          name: cName.trim().slice(0, 120),
          phone: normalized,
          groupIds: cGroupIds.slice(0, 20),
          notes: cNotes.trim().slice(0, 300),
          orgId: ORG_ID,
          createdBy: firebaseUser.uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        setFeedback({ type: 'success', text: `Added ${cName.trim()} (${normalized}).` });
      }
      setContactModalOpen(false);
    } catch (err) {
      handleFirestoreError(err, editingContact ? OperationType.UPDATE : OperationType.CREATE, 'contacts');
    } finally {
      setSavingContact(false);
    }
  };

  const handleDeleteContact = async (c: Contact) => {
    if (!permissions.canManageContacts) return;
    try {
      await deleteDoc(doc(db, 'contacts', c.id));
      setFeedback({ type: 'success', text: `Removed ${c.name} (${c.phone}).` });
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `contacts/${c.id}`);
    }
  };

  const openGroupModal = (group?: ContactGroup) => {
    setEditingGroup(group || null);
    setGName(group?.name || '');
    setGDesc(group?.description || '');
    setGroupModalOpen(true);
  };

  const handleSaveGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser?.email || !permissions.canManageContacts) return;
    if (!gName.trim()) return;

    setSavingGroup(true);
    try {
      if (editingGroup) {
        await updateDoc(doc(db, 'contact_groups', editingGroup.id), {
          name: gName.trim().slice(0, 100),
          description: gDesc.trim().slice(0, 300),
          updatedAt: serverTimestamp(),
        });
        setFeedback({ type: 'success', text: `Updated group "${gName.trim()}".` });
      } else {
        const id = generateSafeId('grp');
        await setDoc(doc(db, 'contact_groups', id), {
          name: gName.trim().slice(0, 100),
          description: gDesc.trim().slice(0, 300),
          orgId: ORG_ID,
          createdBy: firebaseUser.uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        setFeedback({ type: 'success', text: `Created group "${gName.trim()}".` });
      }
      setGroupModalOpen(false);
    } catch (err) {
      handleFirestoreError(err, editingGroup ? OperationType.UPDATE : OperationType.CREATE, 'contact_groups');
    } finally {
      setSavingGroup(false);
    }
  };

  const handleDeleteGroup = async (g: ContactGroup) => {
    if (!permissions.canManageContacts) return;
    try {
      await deleteDoc(doc(db, 'contact_groups', g.id));
      if (selectedGroupId === g.id) setSelectedGroupId('all');
      setFeedback({ type: 'success', text: `Deleted group "${g.name}".` });
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `contact_groups/${g.id}`);
    }
  };

  const handleImportFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = await parseContactsSpreadsheet(file, importDefaultEth);
      setImportRows(parsed);
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Unable to parse spreadsheet.',
      });
    } finally {
      if (importFileRef.current) importFileRef.current.value = '';
    }
  };

  const handleCommitImport = async () => {
    if (!firebaseUser?.email || !permissions.canManageContacts) return;
    const existingPhones = new Set(contacts.map((c) => c.phone));
    const seenInImport = new Set<string>();

    const toCreate = importRows.filter((r) => {
      if (!r.valid) return false;
      if (existingPhones.has(r.phone) || seenInImport.has(r.phone)) return false;
      seenInImport.add(r.phone);
      return true;
    });

    if (toCreate.length === 0) {
      setFeedback({
        type: 'error',
        text: 'No new valid unique contacts to import (all rows were invalid or duplicates).',
      });
      return;
    }

    setImporting(true);
    try {
      // Commit in Firestore batches of 400
      for (let i = 0; i < toCreate.length; i += 400) {
        const chunk = toCreate.slice(i, i + 400);
        const batch = writeBatch(db);
        for (const item of chunk) {
          const id = generateSafeId('cnt');
          batch.set(doc(db, 'contacts', id), {
            name: item.name.slice(0, 120),
            phone: item.phone,
            groupIds: importGroupId ? [importGroupId] : [],
            notes: item.notes.slice(0, 300),
            orgId: ORG_ID,
            createdBy: firebaseUser.uid,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
        await batch.commit();
      }

      void recordAuditLog({
        action: 'CONTACTS_IMPORTED',
        actorUid: firebaseUser.uid,
        actorEmail: firebaseUser.email,
        actorRole: role,
        targetType: 'contacts',
        targetId: importGroupId || 'all',
        summary: `Imported ${toCreate.length} unique contacts from spreadsheet`,
      });

      setImportRows([]);
      setImportModalOpen(false);
      setFeedback({
        type: 'success',
        text: `Imported ${toCreate.length} new contacts cleanly (duplicates & invalid numbers skipped).`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'contacts');
    } finally {
      setImporting(false);
    }
  };

  const handleRemoveDuplicates = async () => {
    if (!firebaseUser?.email || !permissions.canManageContacts || duplicateCount === 0) return;
    setDeduplicating(true);
    try {
      const byPhone = new Map<string, Contact[]>();
      for (const c of contacts) {
        const arr = byPhone.get(c.phone) || [];
        arr.push(c);
        byPhone.set(c.phone, arr);
      }

      let removed = 0;
      const batch = writeBatch(db);

      for (const list of byPhone.values()) {
        if (list.length <= 1) continue;
        const [primary, ...extras] = list;
        const mergedGroups = Array.from(
          new Set(list.flatMap((x) => x.groupIds || []))
        ).slice(0, 20);

        batch.update(doc(db, 'contacts', primary.id), {
          groupIds: mergedGroups,
          updatedAt: serverTimestamp(),
        });

        for (const dup of extras) {
          batch.delete(doc(db, 'contacts', dup.id));
          removed += 1;
        }
      }

      await batch.commit();
      void recordAuditLog({
        action: 'CONTACTS_DEDUPLICATED',
        actorUid: firebaseUser.uid,
        actorEmail: firebaseUser.email,
        actorRole: role,
        targetType: 'contacts',
        targetId: 'dedup',
        summary: `Merged and removed ${removed} duplicate phone numbers`,
      });

      setFeedback({
        type: 'success',
        text: `Removed ${removed} duplicate contact ${removed === 1 ? 'record' : 'records'} and merged groups.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'contacts');
    } finally {
      setDeduplicating(false);
    }
  };

  const handleExport = (format: 'xlsx' | 'csv') => {
    const rows = filteredContacts.map((c) => ({
      Name: c.name,
      Phone: c.phone,
      Groups: (c.groupIds || [])
        .map((id) => groupNameMap.get(id))
        .filter(Boolean)
        .join('; '),
      Notes: c.notes || '',
    }));
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'xlsx') {
      exportRowsToExcel(rows, `zacma_contacts_${stamp}.xlsx`, 'Contacts');
    } else {
      exportRowsToCsv(rows, `zacma_contacts_${stamp}.csv`);
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

      {/* Action Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {permissions.canManageContacts && (
            <>
              <button
                type="button"
                onClick={openAddContact}
                className="min-h-[44px] inline-flex items-center gap-2 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-xs sm:text-sm font-semibold px-4 transition-colors cursor-pointer whitespace-nowrap"
              >
                <Plus className="w-4 h-4" />
                Add Contact
              </button>
              <button
                type="button"
                onClick={() => setImportModalOpen(true)}
                className="min-h-[44px] inline-flex items-center gap-2 rounded-xl bg-white border border-slate-300 hover:bg-slate-50 text-slate-800 text-xs sm:text-sm font-semibold px-4 transition-colors cursor-pointer whitespace-nowrap"
              >
                <Upload className="w-4 h-4 text-blue-700" />
                Import Excel / CSV
              </button>
              <button
                type="button"
                onClick={() => openGroupModal()}
                className="min-h-[44px] inline-flex items-center gap-2 rounded-xl bg-white border border-slate-300 hover:bg-slate-50 text-slate-800 text-xs sm:text-sm font-semibold px-4 transition-colors cursor-pointer whitespace-nowrap"
              >
                <FolderPlus className="w-4 h-4 text-slate-600" />
                New Group
              </button>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {duplicateCount > 0 && permissions.canManageContacts && (
            <button
              type="button"
              onClick={() => void handleRemoveDuplicates()}
              disabled={deduplicating}
              className="min-h-[44px] inline-flex items-center gap-2 rounded-xl bg-red-50 border border-red-200 hover:bg-red-100 text-red-700 text-xs sm:text-sm font-semibold px-3.5 transition-colors cursor-pointer whitespace-nowrap"
            >
              <Sparkles className="w-4 h-4" />
              {deduplicating ? 'Cleaning...' : `Remove ${duplicateCount} Duplicates`}
            </button>
          )}
          <button
            type="button"
            onClick={() => handleExport('xlsx')}
            disabled={filteredContacts.length === 0}
            className="min-h-[44px] inline-flex items-center gap-1.5 rounded-xl bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-semibold px-3.5 cursor-pointer disabled:opacity-50 whitespace-nowrap"
          >
            <Download className="w-4 h-4" />
            Excel
          </button>
          <button
            type="button"
            onClick={() => handleExport('csv')}
            disabled={filteredContacts.length === 0}
            className="min-h-[44px] inline-flex items-center gap-1.5 rounded-xl bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-semibold px-3.5 cursor-pointer disabled:opacity-50 whitespace-nowrap"
          >
            <Download className="w-4 h-4" />
            CSV
          </button>
        </div>
      </div>

      {/* Contact Groups Filter Bar */}
      <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setSelectedGroupId('all')}
            className={`min-h-[40px] px-3.5 py-2 rounded-xl text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap ${
              selectedGroupId === 'all'
                ? 'bg-slate-900 text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            All Contacts ({contacts.length})
          </button>

          {groups.map((g) => {
            const count = contacts.filter((c) => c.groupIds.includes(g.id)).length;
            const active = selectedGroupId === g.id;
            return (
              <div key={g.id} className="inline-flex items-center">
                <button
                  type="button"
                  onClick={() => setSelectedGroupId(g.id)}
                  className={`min-h-[40px] px-3.5 py-2 rounded-l-xl text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                    active
                      ? 'bg-blue-700 text-white'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  {g.name} ({count})
                </button>
                {permissions.canManageContacts && (
                  <button
                    type="button"
                    onClick={() => openGroupModal(g)}
                    className={`min-h-[40px] px-2 rounded-r-xl border-l text-xs cursor-pointer transition-colors ${
                      active
                        ? 'bg-blue-800 border-blue-600 text-blue-100 hover:text-white'
                        : 'bg-slate-100 border-slate-200 text-slate-500 hover:text-slate-900'
                    }`}
                    aria-label={`Edit group ${g.name}`}
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by customer name, +251 phone number, or notes..."
            className="w-full min-h-[44px] pl-10 pr-4 py-2 rounded-xl border border-slate-300 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600"
          />
        </div>
      </div>

      {/* Contacts Table (Desktop) & Touch Cards (Mobile) */}
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        {filteredContacts.length === 0 ? (
          <div className="p-10 text-center space-y-3">
            <p className="font-display text-base font-bold text-slate-800">No contacts found</p>
            <p className="text-xs text-slate-500 max-w-sm mx-auto">
              Add customer phone numbers manually or import an Excel / CSV sheet to build your bulk
              SMS directory.
            </p>
            {permissions.canManageContacts && (
              <div className="flex justify-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={openAddContact}
                  className="min-h-[42px] px-4 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold cursor-pointer"
                >
                  Add First Contact
                </button>
                <button
                  type="button"
                  onClick={() => setImportModalOpen(true)}
                  className="min-h-[42px] px-4 rounded-xl border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-semibold cursor-pointer"
                >
                  Import Spreadsheet
                </button>
              </div>
            )}
          </div>
        ) : (
          <>
            {/* Desktop High-Density Table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                    <th className="py-3 px-4">Customer Name</th>
                    <th className="py-3 px-4">Phone Number</th>
                    <th className="py-3 px-4">Network</th>
                    <th className="py-3 px-4">Groups</th>
                    <th className="py-3 px-4">Notes</th>
                    {permissions.canManageContacts && <th className="py-3 px-4 text-right">Actions</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {filteredContacts.map((c) => (
                    <tr key={c.id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="py-3 px-4 font-semibold text-slate-900">{c.name}</td>
                      <td className="py-3 px-4 font-mono tabular-nums text-slate-800">{c.phone}</td>
                      <td className="py-3 px-4 text-xs text-slate-500">{detectCarrierLabel(c.phone)}</td>
                      <td className="py-3 px-4 text-xs text-slate-600">
                        {c.groupIds.length > 0
                          ? c.groupIds
                              .map((id) => groupNameMap.get(id))
                              .filter(Boolean)
                              .join(' · ')
                          : '—'}
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-500 max-w-[200px] truncate">
                        {c.notes || '—'}
                      </td>
                      {permissions.canManageContacts && (
                        <td className="py-3 px-4 text-right">
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => openEditContact(c)}
                              className="min-h-[36px] min-w-[36px] inline-flex items-center justify-center rounded-lg text-slate-500 hover:text-blue-700 hover:bg-blue-50 cursor-pointer"
                              aria-label={`Edit ${c.name}`}
                            >
                              <Edit3 className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleDeleteContact(c)}
                              className="min-h-[36px] min-w-[36px] inline-flex items-center justify-center rounded-lg text-slate-500 hover:text-red-600 hover:bg-red-50 cursor-pointer"
                              aria-label={`Delete ${c.name}`}
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile Touch Rows */}
            <div className="md:hidden divide-y divide-slate-100">
              {filteredContacts.map((c) => (
                <div key={c.id} className="p-4 flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <p className="font-semibold text-sm text-slate-900 truncate">{c.name}</p>
                    <p className="font-mono tabular-nums text-xs text-blue-700">{c.phone}</p>
                    <p className="text-xs text-slate-500">
                      {detectCarrierLabel(c.phone)}
                      {c.groupIds.length > 0 &&
                        ` · ${c.groupIds
                          .map((id) => groupNameMap.get(id))
                          .filter(Boolean)
                          .join(', ')}`}
                    </p>
                  </div>
                  {permissions.canManageContacts && (
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => openEditContact(c)}
                        className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-slate-600 hover:bg-slate-100 cursor-pointer"
                        aria-label={`Edit ${c.name}`}
                      >
                        <Edit3 className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDeleteContact(c)}
                        className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-red-600 hover:bg-red-50 cursor-pointer"
                        aria-label={`Delete ${c.name}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Add / Edit Contact Modal */}
      {contactModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setContactModalOpen(false)}
        >
          <form
            onSubmit={(e) => void handleSaveContact(e)}
            onClick={(e) => e.stopPropagation()}
            className="w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-2xl p-6 space-y-4 border border-slate-200"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-display text-lg font-bold text-slate-900">
                {editingContact ? 'Edit Contact' : 'Add Customer Contact'}
              </h3>
              <button
                type="button"
                onClick={() => setContactModalOpen(false)}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-slate-700">Customer Name</label>
              <input
                type="text"
                required
                maxLength={120}
                value={cName}
                onChange={(e) => setCName(e.target.value)}
                placeholder="e.g. Dawit Bekele"
                className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-300 text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-slate-700">
                Phone Number (+251 or International)
              </label>
              <input
                type="tel"
                required
                value={cPhone}
                onChange={(e) => setCPhone(e.target.value)}
                placeholder="+251911223344 or 0911223344"
                className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-300 font-mono text-sm"
              />
              {cPhone.length > 4 && (
                <p className="text-xs text-slate-500 font-mono">
                  Normalized: {normalizePhoneNumber(cPhone, true)} ·{' '}
                  {isValidE164Phone(normalizePhoneNumber(cPhone, true))
                    ? detectCarrierLabel(normalizePhoneNumber(cPhone, true))
                    : 'Invalid format'}
                </p>
              )}
            </div>

            {groups.length > 0 && (
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-700">Assign Groups</label>
                <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
                  {groups.map((g) => {
                    const selected = cGroupIds.includes(g.id);
                    return (
                      <button
                        key={g.id}
                        type="button"
                        onClick={() =>
                          setCGroupIds((prev) =>
                            prev.includes(g.id) ? prev.filter((x) => x !== g.id) : [...prev, g.id]
                          )
                        }
                        className={`min-h-[34px] px-3 py-1 rounded-lg border text-xs font-semibold cursor-pointer ${
                          selected
                            ? 'bg-blue-700 border-blue-700 text-white'
                            : 'bg-slate-50 border-slate-200 text-slate-700'
                        }`}
                      >
                        {g.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-slate-700">Notes (Optional)</label>
              <input
                type="text"
                maxLength={300}
                value={cNotes}
                onChange={(e) => setCNotes(e.target.value)}
                placeholder="Branch, company, or account ref"
                className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-300 text-sm"
              />
            </div>

            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={() => setContactModalOpen(false)}
                className="flex-1 min-h-[46px] rounded-xl border border-slate-300 text-sm font-semibold text-slate-700 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingContact}
                className="flex-1 min-h-[46px] rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-sm font-semibold cursor-pointer disabled:opacity-50"
              >
                {savingContact ? 'Saving...' : 'Save Contact'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Group Create / Edit Modal */}
      {groupModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setGroupModalOpen(false)}
        >
          <form
            onSubmit={(e) => void handleSaveGroup(e)}
            onClick={(e) => e.stopPropagation()}
            className="w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-2xl p-6 space-y-4 border border-slate-200"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-display text-lg font-bold text-slate-900">
                {editingGroup ? 'Edit Contact Group' : 'Create Contact Group'}
              </h3>
              <button
                type="button"
                onClick={() => setGroupModalOpen(false)}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-slate-700">Group Name</label>
              <input
                type="text"
                required
                maxLength={100}
                value={gName}
                onChange={(e) => setGName(e.target.value)}
                placeholder="e.g. Addis Enterprise Clients"
                className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-300 text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-slate-700">Description</label>
              <input
                type="text"
                maxLength={300}
                value={gDesc}
                onChange={(e) => setGDesc(e.target.value)}
                placeholder="Optional description of this customer list"
                className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-300 text-sm"
              />
            </div>

            <div className="flex items-center justify-between gap-3 pt-2">
              {editingGroup && (
                <button
                  type="button"
                  onClick={() => {
                    setGroupModalOpen(false);
                    void handleDeleteGroup(editingGroup);
                  }}
                  className="min-h-[46px] px-4 rounded-xl bg-red-50 hover:bg-red-100 text-red-700 text-sm font-semibold cursor-pointer"
                >
                  Delete
                </button>
              )}
              <div className="flex gap-2 flex-1 justify-end">
                <button
                  type="button"
                  onClick={() => setGroupModalOpen(false)}
                  className="min-h-[46px] px-4 rounded-xl border border-slate-300 text-sm font-semibold text-slate-700 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingGroup}
                  className="min-h-[46px] px-5 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-sm font-semibold cursor-pointer disabled:opacity-50"
                >
                  {savingGroup ? 'Saving...' : 'Save Group'}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* Excel / CSV Import Modal */}
      {importModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setImportModalOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full sm:max-w-xl bg-white rounded-t-3xl sm:rounded-2xl p-6 space-y-4 border border-slate-200 max-h-[90vh] flex flex-col"
          >
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-display text-lg font-bold text-slate-900">
                  Import Contacts (Excel / CSV)
                </h3>
                <p className="text-xs text-slate-500">
                  Columns detected automatically: Name, Phone/Mobile, Notes
                </p>
              </div>
              <button
                type="button"
                onClick={() => setImportModalOpen(false)}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="block text-xs font-semibold text-slate-700">
                  Assign to Group (Optional)
                </label>
                <select
                  value={importGroupId}
                  onChange={(e) => setImportGroupId(e.target.value)}
                  className="w-full min-h-[42px] px-3 rounded-xl border border-slate-300 text-xs sm:text-sm bg-white"
                >
                  <option value="">No group</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-700 pt-5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={importDefaultEth}
                  onChange={(e) => setImportDefaultEth(e.target.checked)}
                  className="w-4 h-4 accent-blue-700"
                />
                <span>Convert local 09/07 numbers to +251</span>
              </label>
            </div>

            <input
              ref={importFileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(e) => void handleImportFileChange(e)}
              className="hidden"
            />

            <button
              type="button"
              onClick={() => importFileRef.current?.click()}
              className="w-full min-h-[56px] border border-dashed border-slate-300 hover:border-blue-600 hover:bg-blue-50/40 rounded-xl px-4 py-3 flex items-center justify-center gap-2 text-sm font-semibold text-slate-700 cursor-pointer"
            >
              <Upload className="w-4 h-4 text-blue-700" />
              <span>Choose .xlsx, .xls, or .csv File</span>
            </button>

            {importRows.length > 0 && (
              <div className="flex-1 min-h-0 flex flex-col space-y-2">
                <p className="text-xs font-medium text-slate-600">
                  Parsed {importRows.length} rows ·{' '}
                  <span className="text-emerald-700 font-semibold">
                    {importRows.filter((r) => r.valid).length} valid
                  </span>{' '}
                  ·{' '}
                  <span className="text-red-600 font-semibold">
                    {importRows.filter((r) => !r.valid).length} invalid
                  </span>
                </p>
                <div className="overflow-y-auto border border-slate-200 rounded-xl max-h-52 divide-y divide-slate-100 text-xs">
                  {importRows.slice(0, 60).map((r, idx) => (
                    <div key={idx} className="px-3 py-2 flex items-center justify-between gap-2">
                      <span className="font-medium text-slate-800 truncate">{r.name}</span>
                      <span
                        className={`font-mono ${
                          r.valid ? 'text-slate-700' : 'text-red-600 line-through'
                        }`}
                      >
                        {r.phone || r.rawPhone}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={() => {
                  setImportRows([]);
                  setImportModalOpen(false);
                }}
                className="flex-1 min-h-[46px] rounded-xl border border-slate-300 text-sm font-semibold text-slate-700 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={importing || importRows.filter((r) => r.valid).length === 0}
                onClick={() => void handleCommitImport()}
                className="flex-1 min-h-[46px] rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-sm font-semibold cursor-pointer disabled:opacity-50"
              >
                {importing ? 'Importing...' : 'Import Valid Contacts'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
