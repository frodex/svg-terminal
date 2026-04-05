import { execFileSync } from 'node:child_process';

const GROUP_PREFIX = 'cp-';

export function createSystemAccount(username, displayName) {
  execFileSync('useradd', ['-m', '-c', displayName, '-s', '/bin/bash', username], { stdio: 'pipe' });
  addToGroup(username, 'users');
}

export function deleteSystemAccount(username) {
  execFileSync('userdel', ['-r', username], { stdio: 'pipe' });
}

export function addToGroup(username, group) {
  execFileSync('usermod', ['-aG', GROUP_PREFIX + group, username], { stdio: 'pipe' });
}

export function removeFromGroup(username, group) {
  execFileSync('gpasswd', ['-d', username, GROUP_PREFIX + group], { stdio: 'pipe' });
}

export function createGroup(group) {
  execFileSync('groupadd', [GROUP_PREFIX + group], { stdio: 'pipe' });
}

export function userExists(username) {
  try {
    execFileSync('getent', ['passwd', username], { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

export function groupExists(group) {
  try {
    execFileSync('getent', ['group', GROUP_PREFIX + group], { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

const RESERVED_USERNAMES = new Set([
  'root', 'daemon', 'bin', 'sys', 'sync', 'games', 'man', 'lp', 'mail',
  'news', 'uucp', 'proxy', 'www-data', 'backup', 'list', 'irc', 'gnats',
  'nobody', 'sshd', 'messagebus', 'ntp', 'postfix', 'clamav',
]);

function isReservedUsername(name) {
  // Strip the cp- prefix for checking (since we always prepend cp-)
  const bare = name.startsWith('cp-') ? name.slice(3) : name;
  if (RESERVED_USERNAMES.has(bare)) return true;
  // Block systemd-* pattern
  if (bare.startsWith('systemd-') || bare.startsWith('systemd_')) return true;
  return false;
}

export function generateUsername(email) {
  let base = 'cp-' + email.split('@')[0].replace(/[^a-z0-9_-]/gi, '').toLowerCase().slice(0, 20);
  // Reject reserved system usernames even with cp- prefix
  if (isReservedUsername(base)) {
    base = 'cp-u-' + email.split('@')[0].replace(/[^a-z0-9_-]/gi, '').toLowerCase().slice(0, 17);
  }
  if (!userExists(base)) return base;
  for (let i = 2; i <= 99; i++) {
    const candidate = base + i;
    if (!userExists(candidate)) return candidate;
  }
  throw new Error('Cannot generate username for ' + email);
}

/** Deactivate: rename cp-user → cpx-user, move home dir. */
export function deactivateAccount(username) {
  if (!username.startsWith('cp-')) throw new Error('Can only deactivate cp- accounts');
  const deactivated = 'cpx-' + username.slice(3);
  if (userExists(deactivated)) throw new Error('Deactivated account "' + deactivated + '" already exists');
  execFileSync('usermod', ['-l', deactivated, '-d', '/home/' + deactivated, '-m', '-s', '/usr/sbin/nologin', username], { stdio: 'pipe' });
  try { execFileSync('groupmod', ['-n', deactivated, username], { stdio: 'pipe' }); } catch {}
  return deactivated;
}

/** Reactivate: rename cpx-user → cp-user, restore home dir. */
export function reactivateAccount(deactivatedName) {
  if (!deactivatedName.startsWith('cpx-')) throw new Error('Can only reactivate cpx- accounts');
  const restored = 'cp-' + deactivatedName.slice(4);
  if (userExists(restored)) throw new Error('Account "' + restored + '" already exists');
  execFileSync('usermod', ['-l', restored, '-d', '/home/' + restored, '-m', '-s', '/bin/bash', deactivatedName], { stdio: 'pipe' });
  try { execFileSync('groupmod', ['-n', restored, deactivatedName], { stdio: 'pipe' }); } catch {}
  return restored;
}

/** Purge: delete a cpx- deactivated account and home dir. */
export function purgeAccount(username) {
  if (!username.startsWith('cpx-')) throw new Error('Can only purge cpx- (deactivated) accounts');
  execFileSync('userdel', ['-r', username], { stdio: 'pipe' });
}

export function ensureCpUsersGroup() {
  if (!groupExists('users')) {
    createGroup('users');
  }
}
