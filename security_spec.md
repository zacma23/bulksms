# ZACMA SMS PORTAL — Firestore Security Specification (Phase 0)

## 1. Data Invariants
1. **Verified Identity Required**: Every read and write operation requires `request.auth != null && request.auth.token.email_verified == true`.
2. **RBAC Isolation**: Only the bootstrap administrator (`zekimuluken@gmail.com`) or UIDs registered in `/admins/{uid}` have full admin privileges. Staff users must have an active `/staff_accounts/{emailKey}` record created by an admin.
3. **No Self-Escalation**: Users cannot write to `/admins/{uid}`, cannot modify `/staff_accounts/{staffId}`, and cannot set or upgrade their own `role` to `admin` in `/users/{uid}`.
4. **PII Isolation**: `/users/{uid}` documents are readable only by their owner or an admin. `/contacts/{contactId}` and `/sms_transactions/{txId}` are accessible only to verified admins or active authorized staff.
5. **Immutable Audit Trail**: `/audit_logs/{logId}` is strictly append-only; updates and deletes are unconditionally denied for everyone.
6. **Temporal Integrity**: `createdAt` and `updatedAt` timestamps must match `request.time`; `createdAt` and `createdBy` are immutable after creation.
7. **Phone & Content Bounds**: Contact and transaction phone numbers must strictly match E.164 (`^\+[1-9][0-9]{6,14}$`). All string fields have explicit `.size()` bounds; arrays (`groupIds`) are capped at `<= 20`.
8. **Terminal Campaign Locking**: Campaigns in terminal states (`completed`, `cancelled`) cannot be mutated by non-admin staff.
9. **Path Variable Hardening**: Every single-document operation (`get`, `create`, `update`, `delete`) validates the document ID against `^[a-zA-Z0-9_\-]+$` with length `<= 128`.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Unauthenticated Read/Write**: Attempt to read `/contacts/c1` with `auth = null`.
2. **Unverified Email Spoof**: Attempt to read `/contacts/c1` with `email = 'zekimuluken@gmail.com'` and `email_verified = false`.
3. **Self-Admin Escalation**: Staff user attempts to create `/admins/{uid}` or set `role: 'admin'` on `/users/{uid}`.
4. **Unauthorized Staff Provisioning**: Non-admin user attempts to create `/staff_accounts/attacker_gmail_com`.
5. **Shadow Ghost Field Injection**: Authorized user creates `/contacts/c1` including an undeclared field `isVerified: true`.
6. **ID Poisoning**: Attempt to create `/contacts/` with a 200-char ID or invalid characters (`../etc`).
7. **Identity Spoofing on Create**: Authorized staff creates `/campaigns/camp1` with `createdBy: 'other_uid'`.
8. **Immutable Field Tampering**: Authorized user updates `/contacts/c1` modifying `createdAt` or `createdBy`.
9. **Value Poisoning on Update**: Authorized user updates `/campaigns/camp1` setting `messageTemplate` to a number or >1600 chars.
10. **Terminal State Mutation**: Non-admin staff updates a `completed` campaign back to `sending`.
11. **Audit Log Tampering / Deletion**: Even an admin attempts to update or delete `/audit_logs/log1`.
12. **Client Timestamp Forgery / Array Overflow**: Authorized user creates `/contacts/c1` with forged past `createdAt` or `groupIds` of length 25.
