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
4. Under **Authorized redirect URIs**, click **Add URI**:
   - `https://3200.droidware.ai/auth/callback`
5. Click **Create**
6. A dialog shows **Your Client ID** and **Your Client Secret** — copy both

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
