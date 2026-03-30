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

export function generateUsername(email) {
  let base = email.split('@')[0].replace(/[^a-z0-9_-]/gi, '').toLowerCase().slice(0, 20);
  if (!base) base = 'user';
  if (!userExists(base)) return base;
  for (let i = 2; i <= 99; i++) {
    const candidate = base + i;
    if (!userExists(candidate)) return candidate;
  }
  throw new Error('Cannot generate username for ' + email);
}

export function ensureCpUsersGroup() {
  if (!groupExists('users')) {
    createGroup('users');
  }
}
