function esc(s) {
  return String(s || '').replace(/[&<>"']/g, function(c) {
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}

/** Read the cp_csrf cookie value for double-submit CSRF protection. */
function getCsrfToken() {
  var match = document.cookie.match(/cp_csrf=([^;]+)/);
  return match ? match[1] : '';
}

/** Wrapper for fetch that includes CSRF token header on state-changing requests. */
function csrfFetch(url, opts) {
  opts = opts || {};
  if (opts.method && opts.method !== 'GET' && opts.method !== 'HEAD') {
    opts.headers = opts.headers || {};
    opts.headers['X-CSRF-Token'] = getCsrfToken();
  }
  return fetch(url, opts);
}

var _sudoExpires = 0;
var _pendingSudoAction = null;

function hasSudo() {
  return Date.now() < _sudoExpires;
}

function requirePinThen(action) {
  if (hasSudo()) { action(); return; }
  _pendingSudoAction = action;
  var modal = document.getElementById('pin-modal');
  var input = document.getElementById('pin-input');
  var error = document.getElementById('pin-error');
  modal.style.display = 'flex';
  input.value = '';
  error.style.display = 'none';
  input.focus();
}

document.getElementById('pin-submit').addEventListener('click', async function() {
  var pin = document.getElementById('pin-input').value;
  if (!pin) return;
  var res = await csrfFetch('/api/admin/verify-pin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: pin })
  });
  if (!res.ok) {
    var err = await res.json().catch(function() { return {}; });
    var errorEl = document.getElementById('pin-error');
    errorEl.textContent = err.message || 'Invalid PIN';
    errorEl.style.display = 'block';
    return;
  }
  _sudoExpires = Date.now() + 15 * 60 * 1000;
  document.getElementById('pin-modal').style.display = 'none';
  if (_pendingSudoAction) { _pendingSudoAction(); _pendingSudoAction = null; }
});

document.getElementById('pin-cancel').addEventListener('click', function() {
  document.getElementById('pin-modal').style.display = 'none';
  _pendingSudoAction = null;
});

document.getElementById('set-pin-btn').addEventListener('click', async function() {
  var pin = document.getElementById('set-pin').value;
  if (!pin || pin.length < 4) { alert('PIN must be at least 4 characters'); return; }
  var res = await csrfFetch('/api/admin/set-pin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: pin })
  });
  if (res.ok) { alert('PIN set successfully'); document.getElementById('set-pin').value = ''; }
  else { var err = await res.json().catch(function() { return {}; }); alert('Error: ' + (err.error || 'Failed')); }
});

async function loadPending() {
  var container = document.getElementById('pending-list');
  try {
    var res = await fetch('/api/admin/pending');
    var users = await res.json();
    if (users.length === 0) { container.innerHTML = '<span class="empty">No pending requests</span>'; return; }
    var html = '<table><tr><th>Name</th><th>Email</th><th>Provider</th><th>Linux User</th><th>Requested</th><th>Actions</th></tr>';
    for (var u of users) {
      var autoName = (u.suggested_username || '').replace(/^cp-/, '');
      var eid = esc(u.email);
      html += '<tr><td>' + esc(u.display_name) + '</td><td>' + eid + '</td><td>' +
        esc(u.provider || '\u2014') + '</td><td>' +
        '<span class="cp-prefix">cp-</span><input type="text" class="username-input" id="uname-' + eid + '" value="' + esc(autoName) + '" placeholder="auto" size="12">' +
        '<button class="btn btn-auto" onclick="lookupUsername(\'' + eid + '\')">[check existing]</button>' +
        '<button class="btn btn-auto" onclick="resetUsername(\'' + eid + '\',\'' + esc(autoName) + '\')">[auto-generate]</button>' +
        '<div class="lookup-result" id="lookup-' + eid + '"></div>' +
        '</td><td>' + new Date(u.created_at).toLocaleDateString() +
        '</td><td><button class="btn btn-approve" onclick="approve(\'' + eid +
        '\')">Approve</button><button class="btn btn-deny" onclick="deny(\'' + eid +
        '\')">Deny</button></td></tr>';
    }
    html += '</table>';
    container.innerHTML = html;
  } catch(e) { container.innerHTML = '<span class="empty">Error loading</span>'; }
}

async function loadUsers() {
  var container = document.getElementById('user-list');
  try {
    var res = await fetch('/api/admin/users');
    var users = await res.json();
    if (users.length === 0) { container.innerHTML = '<span class="empty">No users</span>'; return; }
    var html = '<table><tr><th>Name</th><th>Email</th><th>Linux</th><th>Providers</th><th>Status</th><th>Flags</th><th>Actions</th></tr>';
    for (var u of users) {
      var em = esc(u.email);
      var flagsHtml = '';
      var flagNames = ['can_approve_users', 'can_approve_admins', 'can_approve_sudo'];
      var flagLabels = ['approve users', 'approve admins', 'grant sudo'];
      var flagTips = [
        'Can approve or deny pending user requests',
        'Can grant "approve users" permission to others',
        'Can grant all permissions including this one'
      ];
      for (var fi = 0; fi < flagNames.length; fi++) {
        var on = u[flagNames[fi]] ? true : false;
        flagsHtml += '<button class="flag-toggle ' + (on ? 'flag-on' : 'flag-off') + '" ' +
          'title="' + esc(flagTips[fi]) + '" ' +
          'onclick="toggleFlag(\'' + em + '\',\'' + flagNames[fi] + '\',' + (on ? 'false' : 'true') + ')">' +
          flagLabels[fi] + '</button>';
      }
      var provHtml = '';
      if (u.providers && u.providers.length) {
        for (var p of u.providers) {
          provHtml += '<span class="provider-tag">' + esc(p.provider);
          if (u.providers.length > 1) {
            provHtml += ' <button class="btn-unlink" onclick="unlinkProvider(\'' + em + '\',\'' +
              esc(p.provider) + '\',\'' + esc(p.provider_id) + '\')" title="Remove this login method">&times;</button>';
          }
          provHtml += '</span> ';
        }
      } else {
        provHtml = '\u2014';
      }
      var linuxHtml = '<span id="linux-display-' + em + '">' + esc(u.linux_user || '\u2014') +
        (u.linux_user ? ' <button class="btn btn-edit" onclick="editLinuxUser(\'' + em + '\',\'' + esc(u.linux_user) + '\')" title="Edit Linux username">&#9998;</button>' : '') +
        '</span>';
      html += '<tr><td>' + esc(u.display_name) + '</td><td>' + em + '</td><td>' +
        linuxHtml + '</td><td>' + provHtml + '</td><td>' + esc(u.status) + '</td><td>' +
        flagsHtml + '</td><td>' +
        '<button class="btn btn-merge" onclick="mergeUser(\'' + em + '\')">Merge</button>' +
        '<button class="btn btn-deactivate" onclick="deactivateUser(\'' + em + '\')">Deactivate</button>' +
        '<button class="btn btn-force-relogin" onclick="forceRelogin(\'' + em + '\')">Force re-login</button>' +
        '</td></tr>';
    }
    html += '</table>';
    container.innerHTML = html;
  } catch(e) { container.innerHTML = '<span class="empty">Error loading</span>'; }
}

window.unlinkProvider = async function(email, provider, providerId) {
  if (!confirm('Remove ' + provider + ' login from ' + email + '?')) return;
  var res = await csrfFetch('/api/admin/user/' + encodeURIComponent(email) + '/providers', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: provider, providerId: providerId })
  });
  if (!res.ok) {
    var err = await res.json().catch(function() { return {}; });
    alert('Error: ' + (err.error || 'Failed to unlink'));
    return;
  }
  loadUsers();
};

window.lookupUsername = async function(email) {
  var input = document.getElementById('uname-' + email);
  var result = document.getElementById('lookup-' + email);
  var username = input ? input.value.trim() : '';
  if (!username) { result.textContent = 'Type a name first'; return; }
  result.textContent = 'Checking...';
  try {
    var res = await fetch('/api/admin/check-username?username=' + encodeURIComponent(username));
    var check = await res.json();
    if (!check.linuxExists) {
      result.innerHTML = '<span class="lookup-free">cp-' + esc(username.replace(/^cp-/, '')) + ' \u2014 available</span>';
    } else if (check.dbUser) {
      result.innerHTML = '<span class="lookup-taken">' + esc(check.username) + ' \u2192 ' + esc(check.dbUser.email) +
        ' (' + esc(check.dbUser.status) + ')</span>';
    } else {
      result.innerHTML = '<span class="lookup-warn">' + esc(check.username) + ' \u2014 exists (no OAuth linked)</span>';
    }
  } catch (e) {
    result.textContent = 'Lookup failed';
  }
};

window.resetUsername = function(email, auto) {
  var input = document.getElementById('uname-' + email);
  if (input) input.value = auto;
  var result = document.getElementById('lookup-' + email);
  if (result) result.textContent = '';
};

window.approve = async function(email) {
  var input = document.getElementById('uname-' + email);
  var username = input ? input.value.trim() : '';
  var fullName = username ? (username.startsWith('cp-') ? username : 'cp-' + username) : '';
  var payload = { email: email };
  if (username) payload.username = username;

  // Check if username already exists
  if (username) {
    var checkRes = await fetch('/api/admin/check-username?username=' + encodeURIComponent(username));
    var check = await checkRes.json();

    if (check.linuxExists) {
      if (check.dbUser) {
        // Another OAuth user already has this linux account — offer merge
        var mergeMsg = 'Linux user "' + check.username + '" is already assigned to ' + check.dbUser.email + '.\n\n' +
          'MERGE: Add ' + email + '\'s login method(s) to ' + check.dbUser.email + '\'s account.\n' +
          'The pending entry for ' + email + ' will be removed.\n\n' +
          'Proceed?';
        if (!confirm(mergeMsg)) return;
        payload.mergeInto = check.dbUser.email;
      } else {
        // Linux user exists but not a cp- managed account
        var assignMsg = 'Linux user "' + check.username + '" already exists on the system.\n\n' +
          'Assign ' + email + ' to this existing account?\n\n' +
          'They will inherit the existing home directory and files.';
        if (!confirm(assignMsg)) return;
        payload.assignExisting = true;
      }
    } else {
      if (!confirm('Approve ' + email + ' as "' + fullName + '"?')) return;
    }
  } else {
    if (!confirm('Approve ' + email + '?')) return;
  }

  var res = await csrfFetch('/api/admin/approve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    var err = await res.json().catch(function() { return {}; });
    alert('Error: ' + (err.error || 'Approval failed'));
    return;
  }
  loadPending(); loadUsers();
};

window.deny = async function(email) {
  if (!confirm('Deny ' + email + '?')) return;
  await csrfFetch('/api/admin/deny', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email })
  });
  loadPending(); loadUsers();
};

document.getElementById('pre-approve-btn').addEventListener('click', async function() {
  var text = document.getElementById('pre-emails').value.trim();
  if (!text) return;
  var emails = text.split(/[\n,]+/).map(function(e) { return e.trim(); }).filter(Boolean);
  await csrfFetch('/api/admin/pre-approve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emails: emails })
  });
  document.getElementById('pre-emails').value = '';
  loadPending(); loadUsers();
});

window.forceRelogin = async function(email) {
  requirePinThen(async function() {
    if (!confirm('Force ' + email + ' to re-authenticate?\n\nAll their active sessions will be disconnected.')) return;
    var res = await csrfFetch('/api/admin/force-relogin', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email })
    });
    if (!res.ok) {
      var err = await res.json().catch(function() { return {}; });
      if (err.error === 'sudo-required') { requirePinThen(function() { forceRelogin(email); }); return; }
      alert('Error: ' + (err.error || 'Failed'));
      return;
    }
    alert(email + ' has been forced to re-authenticate.');
  });
};

// Toggle admin flags
window.toggleFlag = async function(email, flag, value) {
  requirePinThen(async function() {
    var flags = {};
    flags[flag] = value ? 1 : 0;
    var res = await csrfFetch('/api/admin/user/' + encodeURIComponent(email) + '/flags', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(flags)
    });
    if (!res.ok) {
      var err = await res.json().catch(function() { return {}; });
      if (err.error === 'sudo-required') { requirePinThen(function() { toggleFlag(email, flag, value); }); return; }
      alert('Error: ' + (err.error || 'Failed to update flag'));
      return;
    }
    loadUsers();
  });
};

// Deactivate user (soft delete)
window.deactivateUser = async function(email) {
  requirePinThen(async function() {
    if (!confirm('Deactivate ' + email + '?\n\nThis will:\n- Remove all login methods\n- Rename their Linux account from cp-* to cpx-*\n- Move their home directory\n\nThey can be reactivated later.')) return;
    var res = await csrfFetch('/api/admin/deactivate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email })
    });
    if (!res.ok) {
      var err = await res.json().catch(function() { return {}; });
      if (err.error === 'sudo-required') { requirePinThen(function() { deactivateUser(email); }); return; }
      alert('Error: ' + (err.error || 'Failed to deactivate'));
      return;
    }
    loadUsers(); loadDeactivated();
  });
};

// Reactivate user
window.reactivateUser = async function(email) {
  if (!confirm('Reactivate ' + email + '?\n\nThis will:\n- Rename their Linux account from cpx-* back to cp-*\n- Restore their home directory\n- Set status to pending (they must re-authenticate to get approved)')) return;
  var res = await csrfFetch('/api/admin/reactivate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email })
  });
  if (!res.ok) {
    var err = await res.json().catch(function() { return {}; });
    alert('Error: ' + (err.error || 'Failed to reactivate'));
    return;
  }
  loadUsers(); loadPending(); loadDeactivated();
};

// Purge user (permanent delete)
window.purgeUser = async function(email, linuxUser) {
  requirePinThen(async function() {
    if (!confirm('PERMANENTLY DELETE ' + email + '?\n\nThis will delete:\n- Database entry\n- Linux account ' + (linuxUser || '') + '\n- Home directory and all files\n\nThis cannot be undone!')) return;
    if (!confirm('Are you absolutely sure? Type OK to confirm permanent deletion.')) return;
    var res = await csrfFetch('/api/admin/purge', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email })
    });
    if (!res.ok) {
      var err = await res.json().catch(function() { return {}; });
      if (err.error === 'sudo-required') { requirePinThen(function() { purgeUser(email, linuxUser); }); return; }
      alert('Error: ' + (err.error || 'Failed to purge'));
      return;
    }
    loadDeactivated();
  });
};

// Edit Linux username
window.editLinuxUser = function(email, currentName) {
  var newName = prompt('Edit Linux username for ' + email + ':\n\nMust start with cp-\nNote: this only updates the DB mapping, it does NOT rename the actual Linux account.', currentName);
  if (!newName || newName === currentName) return;
  if (!newName.startsWith('cp-')) {
    alert('Username must start with cp-');
    return;
  }
  (async function() {
    var res = await csrfFetch('/api/admin/user/' + encodeURIComponent(email) + '/linux-user', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ linux_user: newName })
    });
    if (!res.ok) {
      var err = await res.json().catch(function() { return {}; });
      alert('Error: ' + (err.error || 'Failed to update'));
      return;
    }
    loadUsers();
  })();
};

// Merge user
window.mergeUser = async function(sourceEmail) {
  requirePinThen(async function() {
    var targetEmail = prompt('Merge ' + sourceEmail + ' INTO which user?\n\nEnter the email of the target user (the one that will remain):');
    if (!targetEmail) return;
    if (!confirm('Merge ' + sourceEmail + ' into ' + targetEmail + '?\n\nProvider links will be moved to ' + targetEmail + '.\n' + sourceEmail + ' will be deleted.')) return;
    var res = await csrfFetch('/api/admin/merge', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceEmail: sourceEmail, targetEmail: targetEmail })
    });
    if (!res.ok) {
      var err = await res.json().catch(function() { return {}; });
      if (err.error === 'sudo-required') { requirePinThen(function() { mergeUser(sourceEmail); }); return; }
      alert('Error: ' + (err.error || 'Merge failed'));
      return;
    }
    loadUsers();
  });
};

// Add user manually
document.getElementById('add-user-btn').addEventListener('click', async function() {
  var email = document.getElementById('add-email').value.trim();
  if (!email) { alert('Email is required'); return; }
  var displayName = document.getElementById('add-name').value.trim();
  var linuxRaw = document.getElementById('add-linux').value.trim();
  var linuxUser = linuxRaw ? (linuxRaw.startsWith('cp-') ? linuxRaw : 'cp-' + linuxRaw) : '';
  var status = document.getElementById('add-status').value;
  var isAdmin = document.getElementById('add-admin').checked;
  var payload = { email: email, display_name: displayName || undefined, status: status, is_admin: isAdmin };
  if (linuxUser) payload.linux_user = linuxUser;
  var res = await csrfFetch('/api/admin/add-user', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    var err = await res.json().catch(function() { return {}; });
    alert('Error: ' + (err.error || 'Failed to add user'));
    return;
  }
  document.getElementById('add-email').value = '';
  document.getElementById('add-name').value = '';
  document.getElementById('add-linux').value = '';
  document.getElementById('add-admin').checked = false;
  loadUsers();
});

async function loadDeactivated() {
  var container = document.getElementById('deactivated-list');
  try {
    var res = await fetch('/api/admin/deactivated');
    var users = await res.json();
    if (users.length === 0) { container.innerHTML = '<span class="empty">No deactivated users</span>'; return; }
    var html = '<table><tr><th>Name</th><th>Email</th><th>Linux (frozen)</th><th>Deactivated</th><th>Actions</th></tr>';
    for (var u of users) {
      html += '<tr><td>' + esc(u.display_name) + '</td><td>' + esc(u.email) + '</td><td>' +
        esc(u.linux_user || '\u2014') + '</td><td>' + new Date(u.created_at).toLocaleDateString() +
        '</td><td>' +
        '<button class="btn btn-reactivate" onclick="reactivateUser(\'' + esc(u.email) + '\')">Reactivate</button>' +
        '<button class="btn btn-purge" onclick="purgeUser(\'' + esc(u.email) + '\',\'' + esc(u.linux_user || '') + '\')">Purge</button>' +
        '</td></tr>';
    }
    html += '</table>';
    container.innerHTML = html;
  } catch(e) { container.innerHTML = '<span class="empty">Error loading</span>'; }
}

loadPending();
loadUsers();
loadDeactivated();
