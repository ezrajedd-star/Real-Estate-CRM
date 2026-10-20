# User guide — Phase 1 (staff)

Phase 1 covers sign-in, companies and contacts, approvals, rates/configuration, imports, the
audit log and account security. Leasing, billing and collections arrive in Phases 2–3; each
phase extends this guide per role.

## Signing in

1. Open the app and choose **Sign in**. Use your company Google account (or the account IT
   created for you).
2. Confirm with your **passkey** (preferred) or authenticator app code. SMS codes are not
   accepted.
3. You are signed out after **15 minutes of inactivity** and after **12 hours** at most.
   Sensitive actions (role changes, adding bank details, downloading exports) may ask you to
   confirm your identity again.

Manage your devices under **My account → Active sessions**. Sign out any session you don't
recognise and tell IT Security.

## What each role can do in Phase 1

| Role                     | Can                                                                                                                                                                        | Cannot                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Super Admin (IT)         | Users list, request role changes, properties, system configuration proposals                                                                                               | See tenant data or PII (emergency break-glass only: time-limited, reasoned, alerts Security) |
| Executive                | Read companies (masked), approvals list, configuration                                                                                                                     | Reveal PII, change data                                                                      |
| Leasing Head             | Companies & contacts (all properties), KYC, reveal TINs/contact details, imports, request exports                                                                          | Reveal bank accounts or government IDs, approve config, read audit logs                      |
| Leasing Manager          | Same as Leasing Head but only for **assigned properties**                                                                                                                  | Anything outside those properties                                                            |
| Leasing Officer          | Contacts for **assigned tenants**, reveal contact details, record consent, upload documents                                                                                | Reveal TINs, KYC, create companies, imports                                                  |
| Billing Officer          | Read companies and contacts, reveal contact details, read configuration                                                                                                    | Reveal TINs/bank, KYC                                                                        |
| Property / Admin Officer | Companies (no financials), properties, documents                                                                                                                           | KYC, bank, configuration, any PII reveal                                                     |
| Finance                  | Reveal TINs and bank accounts, approve configuration and exports, imports                                                                                                  | Government IDs, role approvals, audit log                                                    |
| Compliance / DPO         | Approve role changes, configuration and exports, privacy notices, KYC, reveal TINs/government IDs/contact details, audit log, security alerts, access reviews, offboarding | Bank accounts, editing companies, proposing config                                           |
| Internal Auditor         | Read everything permitted read-only, including the audit log                                                                                                               | Reveal PII, change anything, approve                                                         |

## Revealing personal data

TINs, IDs, contact details and bank numbers are **masked**. Choose **Reveal**, state why
(e.g. "Preparing lease contract"), and the value shows for 60 seconds. Your name, the time
and your reason are recorded.

## Approvals (maker–checker)

Role changes, tax rates/configuration and bulk exports are **requests** until someone else
with the right role approves them. You can never approve your own request. Find your queue
under **Approvals**. A rejection needs a comment.

## Rates & configuration

Tax rates and thresholds have **effective dates**. A change starts on a date you choose and
closes the previous period; history is kept. Rows marked **needs confirmation** are
placeholders to be validated by the accountant before go-live.

## Excel imports

**Imports →** choose the type, upload the `.xlsx`, wait for the malware scan, then review the
preview. Sensitive columns are masked. Fix any rows with errors in Excel and upload the
corrected file as a new import. **Commit** writes the rows; committing twice does nothing
new.

Columns:

- **Companies:** Legal Name, Trade Name, Registration Type (SEC/DTI/…), Registration No, TIN,
  VAT Status, Registered Address, Industry.
- **Contacts:** Company TIN, Full Name, Role, Title, Email, Phone, Gov Id Type, Gov Id.

## Offboarding (Compliance/DPO)

**Users → offboard** immediately blocks the person everywhere. It signs them out of all
sessions and disables their sign-in account.
