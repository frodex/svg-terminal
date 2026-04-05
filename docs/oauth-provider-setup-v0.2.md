# OAuth Provider Setup Guide

## GitHub

**URL:** https://github.com/settings/developers

1. Click **OAuth Apps** in the left sidebar
2. Click **New OAuth App**
3. Fill in:
   - **Application name**: svg-terminal (or whatever you want users to see)
   - **Homepage URL**: `https://3200.droidware.ai`
   - **Authorization callback URL**: `https://3200.droidware.ai/auth/callback`
4. Click **Register application**
5. On the app page, copy the **Client ID** (shown at top)
6. Click **Generate a new client secret** — copy the secret immediately (it's only shown once)

```
GITHUB_CLIENT_ID=<Client ID>
GITHUB_CLIENT_SECRET=<Client Secret>
```

---

## Google

**Step 1 — OAuth Consent Screen (required first):**

**URL:** https://console.cloud.google.com/apis/credentials/consent

1. Select **External** user type (unless you have a Google Workspace org and want internal-only)
2. Click **Create**
3. Fill in:
   - **App name**: svg-terminal
   - **User support email**: your email
   - **Developer contact information**: your email
4. Click **Save and Continue**
5. On the **Scopes** screen, click **Add or Remove Scopes**, add:
   - `openid`
   - `email`
   - `profile`
6. Click **Save and Continue** through the remaining screens

**Step 2 — Create OAuth Client ID:**

**URL:** https://console.cloud.google.com/apis/credentials

1. Click **Create Credentials** → **OAuth client ID**
2. **Application type**: Web application
3. **Name**: svg-terminal
4. Under **Authorized JavaScript origins**, click **Add URI**:
   - `https://3200.droidware.ai`
5. Under **Authorized redirect URIs**, click **Add URI**:
   - `https://3200.droidware.ai/auth/callback`
6. Click **Create**
7. A dialog shows **Your Client ID** and **Your Client Secret** — copy both

```
GOOGLE_CLIENT_ID=<Client ID>
GOOGLE_CLIENT_SECRET=<Client Secret>
```

---

## Microsoft / Azure AD

**URL:** https://portal.azure.com/#view/Microsoft_AAD_RegisteredApplications/ApplicationsListBlade

1. Click **New registration**
2. Fill in:
   - **Name**: svg-terminal
   - **Supported account types**: choose one:
     - **Accounts in any organizational directory and personal Microsoft accounts** (broadest — includes outlook.com, hotmail, work/school)
     - **Accounts in any organizational directory** (work/school only, no personal)
     - **Single tenant** (your org only)
   - Under **Redirect URI**, select **Web** platform, enter: `https://3200.droidware.ai/auth/callback`
3. Click **Register**
4. On the app overview page, copy **Application (client) ID** and **Directory (tenant) ID**

**Create a client secret:**

5. In the left sidebar, click **Certificates & secrets**
6. Click **New client secret**
7. **Description**: svg-terminal
8. **Expires**: choose duration (recommend 24 months)
9. Click **Add**
10. Copy the **Value** column immediately (it's only shown once — the "Secret ID" column is not what you need)

```
MICROSOFT_CLIENT_ID=<Application (client) ID>
MICROSOFT_CLIENT_SECRET=<Client secret Value>
MICROSOFT_TENANT=<Directory (tenant) ID, or "common" for multi-tenant>
```

---

## Server Configuration

The server runs via systemd. Environment variables are set in `/etc/systemd/system/svg-terminal.service`.

### Required environment variables

| Variable | Description |
|----------|-------------|
| `PUBLIC_URL` | Public base URL, e.g. `https://3200.droidware.ai` |
| `AUTH_SECRET` | Random 64-char hex string for signing session cookies. Generate once with `openssl rand -hex 32` and reuse. |

### Provider variables (only configure the providers you need)

| Variable | Provider |
|----------|----------|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` / `MICROSOFT_TENANT` | Microsoft |

The login page only shows buttons for providers that have env vars set.

### Adding variables to the service file

Edit the service file:

```bash
sudo nano /etc/systemd/system/svg-terminal.service
```

Add `Environment=` lines in the `[Service]` section:

```ini
Environment=PUBLIC_URL=https://3200.droidware.ai
Environment=AUTH_SECRET=<your-generated-secret>
Environment=GOOGLE_CLIENT_ID=<your-client-id>
Environment=GOOGLE_CLIENT_SECRET=<your-client-secret>
Environment=GITHUB_CLIENT_ID=<your-client-id>
Environment=GITHUB_CLIENT_SECRET=<your-client-secret>
Environment=MICROSOFT_CLIENT_ID=<your-client-id>
Environment=MICROSOFT_CLIENT_SECRET=<your-client-secret>
Environment=MICROSOFT_TENANT=common
```

### Applying changes

After editing the service file, reload and restart:

```bash
sudo systemctl daemon-reload
sudo systemctl restart svg-terminal
```

### Verify

```bash
systemctl status svg-terminal
journalctl -u svg-terminal -f
```

---

## User Lifecycle

Users go through these states: **pending → approved → deactivated → (reactivated as pending, or purged)**

### Username Conventions

- All managed user accounts use the `cp-` prefix (e.g. `cp-greg`, `cp-aaronb`)
- Deactivated accounts are renamed to `cpx-` prefix (e.g. `cpx-greg`)
- System accounts (root, claude-proxy) do not use these prefixes
- The admin panel cannot assign users to non-`cp-` system accounts
- Reserved system usernames (root, daemon, nobody, www-data, etc.) are blocked even with `cp-` prefix

---

### 1. New User Sign-In (OAuth)

When a new user signs in via any OAuth provider for the first time:

1. Server exchanges the OAuth code for the user's email, display name, and provider ID
2. Server checks `provider_links` table first (handles multi-provider login for existing users)
3. Falls back to checking the `users` table by email
4. If no match found, a new entry is created with `status: pending`
5. User is redirected to `/pending` — a waiting room with a "Check Status" button
6. The "Check Status" button queries `/auth/status?email=...` (does not require a session cookie)
7. When approved, the status endpoint sets the session cookie and redirects to dashboard

### 2. Admin Approves a Pending User

The admin panel at `/admin` shows pending requests with an editable username field:

1. The auto-generated username is shown as `cp-` + email prefix (e.g. `cp-greg`)
2. Admin can override the username, use **[check existing]** to look up a name, or **[auto-generate]** to reset
3. Admin clicks **Approve**

**Scenario A — New username (doesn't exist):**
1. Linux account `cp-username` is created via `useradd -m`
2. Account is added to `cp-users` group
3. User status → `approved`, linux_user saved to DB
4. User can now sign in and access the dashboard

**Scenario B — Username matches an existing `cp-` user with OAuth:**
1. Admin is prompted: "MERGE: Add login methods to existing user?"
2. If confirmed, provider links are moved from pending user to existing user
3. Pending DB entry is deleted — no duplicate accounts
4. Both OAuth providers now resolve to the same user

**Scenario C — Username matches an existing Linux account (no OAuth):**
1. Admin is prompted: "Assign to this existing account?"
2. If confirmed, the OAuth user is mapped to the existing Linux account (no new account created)

### 3. Admin Denies a Pending User

1. User status → `denied`
2. No Linux account is created
3. If the user tries to sign in again, they see "Access denied"

### 4. Pre-Approved Users

Admins can pre-approve email addresses at `/admin` before the user ever signs in:

1. Enter emails in the "Pre-Approve by Email" textarea
2. When a pre-approved user signs in for the first time:
   - Linux account is provisioned immediately
   - Session cookie is set, user goes straight to the dashboard

### 5. Add User Manually (Admin Panel)

The admin panel has an "Add User Manually" form:

1. Enter email, display name, Linux username (with `cp-` prefix)
2. Choose status: Approved or Pending
3. Toggle Admin checkbox for full admin permissions
4. If status is Approved and username provided, Linux account is created automatically

### 6. Multi-Provider Login

A single user can have multiple OAuth providers linked (e.g. Google + Microsoft):

1. Provider links are stored in the `provider_links` table
2. When signing in, the server checks provider links first, then email
3. All providers resolve to the same user record, same Linux account, same session
4. Admins can view linked providers per user in the admin panel
5. Admins can unlink a provider (× button) — but cannot remove the last one

### 7. Deactivate User (Soft Delete)

When an admin clicks **Deactivate** on an active user:

1. Confirmation dialog explains the action
2. All provider links are removed (user can no longer sign in)
3. Linux account is renamed: `cp-user` → `cpx-user`
4. Home directory is moved: `/home/cp-user` → `/home/cpx-user`
5. Shell is set to `/usr/sbin/nologin`
6. User status → `deactivated`
7. User appears in the "Deactivated Users" section of the admin panel

### 8. Reactivate User

When an admin clicks **Reactivate** on a deactivated user:

1. Linux account is renamed back: `cpx-user` → `cp-user`
2. Home directory is restored: `/home/cpx-user` → `/home/cp-user`
3. Shell is restored to `/bin/bash`
4. User status → `pending`
5. User must re-authenticate via OAuth to get a new provider link
6. Admin must approve them again (or they can self-approve if pre-approved)

### 9. Purge User (Permanent Delete)

When an admin clicks **Purge** on a deactivated user:

1. Double confirmation required (two confirm dialogs)
2. Linux account `cpx-user` is deleted along with home directory
3. All database records (user row + any remaining provider links) are permanently removed
4. **This cannot be undone**

Note: Purge is only available for deactivated users. Active users must be deactivated first.

---

## Admin Panel Features

The admin panel at `/admin` (visible in hamburger menu for admins) provides:

| Feature | Description |
|---------|-------------|
| **Pending Requests** | Approve/deny with editable username, [check existing], [auto-generate] |
| **Pre-Approve by Email** | Bulk textarea for email addresses |
| **Add User Manually** | Form with email, name, username, status, admin flag |
| **All Users** | View/edit flags, edit Linux username, merge users, deactivate |
| **Deactivated Users** | Reactivate or permanently purge |

### Admin Permission Flags

| Flag | Grants |
|------|--------|
| `can_approve_users` | Can approve/deny pending requests |
| `can_approve_admins` | Can grant `can_approve_users` to others |
| `can_approve_sudo` | Can grant all flags including `can_approve_sudo` |

Flags are toggled per-user via clickable buttons in the admin panel.

---

## Security

- **CSRF Protection**: Double-submit cookie pattern — server sets `cp_csrf` cookie, clients send it as `X-CSRF-Token` header on mutations
- **Session Cookies**: HMAC-SHA256 signed, HttpOnly, SameSite=Lax, 24-hour expiry
- **Auth Required**: All admin endpoints, SSE, and WebSocket connections require authenticated + approved user
- **CORS**: Restricted to `PUBLIC_URL` origin (no wildcard in production)
- **CSP Headers**: Content-Security-Policy set on all HTML responses
- **WebSocket Origin Validation**: Upgrade requests checked against `PUBLIC_URL`
- **Request Size Limit**: POST body limited to 1MB
- **OAuth State**: In-memory state map limited to 1000 entries, 10-minute expiry
- **GitHub Email**: Only verified primary emails accepted (no unverified fallback)
- **Reserved Usernames**: System usernames blocked even with `cp-` prefix
- **DB Permissions**: SQLite database files set to 0600 (owner-only)
