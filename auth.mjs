import * as oidc from 'openid-client';
import { randomBytes } from 'node:crypto';

const pendingStates = new Map();
const MAX_PENDING_STATES = 1000;

function generateState(provider) {
  if (pendingStates.size >= MAX_PENDING_STATES) {
    throw new Error('Too many pending authentication requests. Please try again later.');
  }
  const state = randomBytes(24).toString('base64url');
  pendingStates.set(state, { provider, expires: Date.now() + 600000 });
  return state;
}

function consumeState(state) {
  const entry = pendingStates.get(state);
  if (!entry) return null;
  pendingStates.delete(state);
  if (Date.now() > entry.expires) return null;
  return entry;
}

setInterval(() => {
  for (const [key, val] of pendingStates) {
    if (Date.now() > val.expires) pendingStates.delete(key);
  }
}, 60000);

const oidcConfigs = new Map();

async function getOidcConfig(provider, config, callbackUrl) {
  if (oidcConfigs.has(provider)) return oidcConfigs.get(provider);
  const urls = {
    google: 'https://accounts.google.com',
    microsoft: 'https://login.microsoftonline.com/' + (config.tenant || 'common') + '/v2.0',
  };
  const discoveryUrl = urls[provider];
  if (!discoveryUrl) throw new Error('Unknown OIDC provider: ' + provider);
  const oidcConfig = await oidc.discovery(
    new URL(discoveryUrl),
    config.clientId,
    { client_secret: config.clientSecret, redirect_uris: [callbackUrl], response_types: ['code'] },
    oidc.ClientSecretPost(config.clientSecret),
  );
  oidcConfigs.set(provider, oidcConfig);
  return oidcConfig;
}

async function githubExchange(code, config) {
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('Failed to get GitHub access token');
  const userRes = await fetch('https://api.github.com/user', {
    headers: { Authorization: 'Bearer ' + tokenData.access_token, Accept: 'application/json' },
  });
  const user = await userRes.json();
  const emailRes = await fetch('https://api.github.com/user/emails', {
    headers: { Authorization: 'Bearer ' + tokenData.access_token, Accept: 'application/json' },
  });
  const emails = await emailRes.json();
  const primary = emails.find(e => e.primary && e.verified);
  if (!primary || !primary.email) {
    throw new Error('No verified primary email found on GitHub account. Please verify your email on GitHub and try again.');
  }
  const email = primary.email;
  return { email, displayName: user.name || user.login, providerId: String(user.id) };
}

export async function getAuthUrlAsync(provider, providers, callbackUrl) {
  const state = generateState(provider);
  if (provider === 'github') {
    const config = providers.github;
    if (!config) throw new Error('GitHub not configured');
    const params = new URLSearchParams({
      client_id: config.clientId, redirect_uri: callbackUrl,
      scope: 'read:user user:email', state,
    });
    return { url: 'https://github.com/login/oauth/authorize?' + params, state };
  }
  const config = providers[provider];
  if (!config) throw new Error('Provider "' + provider + '" not configured');
  const oidcConfig = await getOidcConfig(provider, config, callbackUrl);
  const url = oidc.buildAuthorizationUrl(oidcConfig, {
    scope: 'openid email profile', state, redirect_uri: callbackUrl,
  });
  return { url: url.href, state };
}

export async function handleCallback(callbackUrl, query, providers) {
  const { state, code } = query;
  if (!state || !code) throw new Error('Missing state or code');
  const stateEntry = consumeState(state);
  if (!stateEntry) throw new Error('Invalid or expired OAuth state');
  const provider = stateEntry.provider;
  if (provider === 'github') {
    const identity = await githubExchange(code, providers.github);
    return { provider, ...identity };
  }
  const config = providers[provider];
  if (!config) throw new Error('Provider "' + provider + '" not configured');
  const oidcConfig = await getOidcConfig(provider, config, callbackUrl);
  const currentUrl = new URL(callbackUrl);
  currentUrl.searchParams.set('code', code);
  currentUrl.searchParams.set('state', state);
  if (query.iss) currentUrl.searchParams.set('iss', query.iss);
  const tokenResponse = await oidc.authorizationCodeGrant(oidcConfig, currentUrl, { expectedState: state });
  const claims = tokenResponse.claims();
  if (!claims) throw new Error('No ID token claims');
  return { provider, email: claims.email, displayName: claims.name || claims.email, providerId: claims.sub };
}

export function getSupportedProviders(providers) {
  return Object.keys(providers).filter(k => providers[k]);
}
