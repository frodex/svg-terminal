# Admin Panel Reference

**URL:** `https://3200.droidware.ai/admin`
**Access:** Visible in hamburger menu for users with any `can_approve_*` flag. Accessible directly at `/admin`.
**Source:** `admin.html`, `admin-client.mjs`

---

## Page Layout

The admin panel has 5 sections, top to bottom:

1. Pending Requests
2. Pre-Approve by Email
3. Add User Manually
4. All Users
5. Deactivated Users

---

## 1. Pending Requests

Shows users who have signed in via OAuth but have not yet been approved.

**Table columns:** Name, Email, Provider, Linux User, Requested, Actions

### Linux User Field

Each pending user has an editable username input with `cp-` prefix shown:

- **Text input** — pre-filled with auto-generated username (email prefix, sanitized)
- **[check existing]** — looks up the typed name and shows result below:
  - Green: `cp-name — available`
  - Orange: `cp-name → user@email (approved)` — already assigned to another user
  - Red: `cp-name — exists (no OAuth linked)` — Linux account exists but no DB user
- **[auto-generate]** — resets input to the auto-generated value and clears lookup result

### Approve Button

1. If username field is filled, checks if that Linux user already exists
2. **New username:** Confirm dialog → creates Linux account `cp-name`, adds to `cp-users` group, status → approved
3. **Existing username with OAuth user:** Offers MERGE — moves provider links from pending user to existing user, deletes pending entry
4. **Existing Linux account, no OAuth:** Offers to assign the OAuth user to the existing Linux account
5. If username field is empty, auto-generates

**API:** `POST /api/admin/approve` with `{ email, username?, assignExisting?, mergeInto? }`

### Deny Button

1. Confirm dialog
2. Status → denied
3. User sees "Access denied" if they try to sign in again

**API:** `POST /api/admin/deny` with `{ email }`

---

## 2. Pre-Approve by Email

Textarea for entering email addresses (one per line or comma-separated).

1. Click **Pre-Approve**
2. Each email gets a DB entry with `status: approved` (no Linux account yet)
3. When the user signs in for the first time, they skip the pending queue — Linux account is provisioned and they go straight to the dashboard

**API:** `POST /api/admin/pre-approve` with `{ emails: [...] }`

---

## 3. Add User Manually

Form for creating a user without requiring OAuth sign-in first.

**Fields:**
- **Email** (required)
- **Display Name** (optional — defaults to email prefix)
- **Linux User** — text input with `cp-` prefix label. Server enforces `cp-` prefix.
- **Status** — dropdown: Approved or Pending
- **Admin** — checkbox: sets all three `can_approve_*` flags

**Behavior:**
1. If status is Approved and Linux username is provided:
   - Linux account is created via `useradd -m`
   - User is added to `cp-users` group
2. If status is Pending: DB entry only, no Linux account

**API:** `POST /api/admin/add-user` with `{ email, display_name?, linux_user?, status, is_admin }`

---

## 4. All Users

Shows every user in the database (except deactivated).

**Table columns:** Name, Email, Linux, Providers, Status, Flags, Actions

### Linux Column

- Shows the assigned Linux username (e.g. `cp-greg`)
- **Pencil button (✎)** — opens prompt to edit the Linux username
  - Must start with `cp-`
  - Only updates the DB mapping — does NOT rename the actual Linux account on disk
  - Server validates no conflicts

**API:** `PATCH /api/admin/user/:email/linux-user` with `{ linux_user }`

### Providers Column

- Shows provider tags (e.g. `google`, `microsoft`)
- If a user has multiple providers, each tag has an **×** button to unlink it
- Cannot unlink the last remaining provider (error returned)

**API:**
- `GET /api/admin/user/:email/providers` — list links
- `DELETE /api/admin/user/:email/providers` with `{ provider, providerId }` — remove link

### Flags Column

Three toggle buttons per user:

| Button | Flag | Meaning |
|--------|------|---------|
| **users** | `can_approve_users` | Can approve/deny pending requests |
| **admins** | `can_approve_admins` | Can grant `can_approve_users` to others |
| **sudo** | `can_approve_sudo` | Can grant all flags including itself |

- Green = on, grey = off
- Click to toggle

**API:** `PATCH /api/admin/user/:email/flags` with `{ can_approve_users: 0|1, ... }`

### Merge Button

1. Prompts for the target email (the user to merge INTO)
2. Confirm dialog explains: provider links move to target, source is deleted
3. Source user's DB entry is removed, their provider links transfer to target

**API:** `POST /api/admin/merge` with `{ sourceEmail, targetEmail }`

### Deactivate Button

1. Confirm dialog explains:
   - All login methods removed
   - Linux account renamed `cp-*` → `cpx-*`
   - Home directory moved
2. User status → `deactivated`
3. User moves to the Deactivated Users section
4. Cannot deactivate yourself

**API:** `POST /api/admin/deactivate` with `{ email }`

**What happens on the server:**
1. All entries in `provider_links` for this email are deleted
2. Linux account renamed: `usermod -l cpx-name -d /home/cpx-name -m -s /usr/sbin/nologin cp-name`
3. Primary group renamed: `groupmod -n cpx-name cp-name`
4. DB updated: `linux_user` → `cpx-name`, `status` → `deactivated`

---

## 5. Deactivated Users

Shows users that have been deactivated (soft deleted).

**Table columns:** Name, Email, Linux (frozen), Deactivated, Actions

### Reactivate Button

1. Confirm dialog explains:
   - Linux account renamed back `cpx-*` → `cp-*`
   - Home directory restored
   - Status set to pending — user must re-authenticate via OAuth
2. User moves back to Pending Requests

**API:** `POST /api/admin/reactivate` with `{ email }`

**What happens on the server:**
1. Linux account renamed: `usermod -l cp-name -d /home/cp-name -m -s /bin/bash cpx-name`
2. Primary group renamed: `groupmod -n cp-name cpx-name`
3. DB updated: `linux_user` → `cp-name`, `status` → `pending`
4. User has no provider links — must sign in via OAuth to create one
5. Admin must approve them again (appears in Pending Requests)

### Purge Button

1. First confirm: "PERMANENTLY DELETE — database entry, Linux account, home directory, all files"
2. Second confirm: "Are you absolutely sure?"
3. `cpx-name` Linux account deleted via `userdel -r`
4. All DB records permanently removed

**API:** `POST /api/admin/purge` with `{ email }`

Note: Purge is only available for deactivated users. Active users must be deactivated first.

---

## API Endpoint Summary

All mutation endpoints require admin session cookie + CSRF token (`X-CSRF-Token` header).

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/admin/pending` | List pending users (includes `suggested_username`) |
| GET | `/api/admin/users` | List all users (includes `providers` array) |
| GET | `/api/admin/deactivated` | List deactivated users |
| GET | `/api/admin/check-username?username=` | Check if Linux user exists + who owns it |
| POST | `/api/admin/approve` | Approve pending user (create account or merge) |
| POST | `/api/admin/deny` | Deny pending user |
| POST | `/api/admin/pre-approve` | Pre-approve email list |
| POST | `/api/admin/add-user` | Manually create user |
| POST | `/api/admin/deactivate` | Soft-delete user |
| POST | `/api/admin/reactivate` | Restore deactivated user as pending |
| POST | `/api/admin/purge` | Permanently delete deactivated user |
| POST | `/api/admin/merge` | Merge two user accounts |
| PATCH | `/api/admin/user/:email/flags` | Toggle permission flags |
| PATCH | `/api/admin/user/:email/linux-user` | Update Linux username mapping |
| GET | `/api/admin/user/:email/providers` | List provider links |
| DELETE | `/api/admin/user/:email/providers` | Remove a provider link |

---

## Username Conventions

| Prefix | Meaning |
|--------|---------|
| `cp-` | Active managed user account |
| `cpx-` | Deactivated (frozen) user account |
| `root` | System admin (not managed by admin panel) |
| `claude-proxy` | Future service account (not managed by admin panel) |

- All new accounts created through the admin panel use `cp-` prefix
- Reserved system usernames (root, daemon, nobody, www-data, sshd, systemd-*, etc.) are blocked even with `cp-` prefix
- The admin panel cannot assign users to non-`cp-` system accounts
