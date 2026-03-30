function esc(s) {
  return String(s || '').replace(/[&<>"']/g, function(c) {
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}

async function loadPending() {
  var container = document.getElementById('pending-list');
  try {
    var res = await fetch('/api/admin/pending');
    var users = await res.json();
    if (users.length === 0) { container.innerHTML = '<span class="empty">No pending requests</span>'; return; }
    var html = '<table><tr><th>Name</th><th>Email</th><th>Provider</th><th>Requested</th><th>Actions</th></tr>';
    for (var u of users) {
      html += '<tr><td>' + esc(u.display_name) + '</td><td>' + esc(u.email) + '</td><td>' +
        esc(u.provider || '\u2014') + '</td><td>' + new Date(u.created_at).toLocaleDateString() +
        '</td><td><button class="btn btn-approve" onclick="approve(\'' + esc(u.email) +
        '\')">Approve</button><button class="btn btn-deny" onclick="deny(\'' + esc(u.email) +
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
    var html = '<table><tr><th>Name</th><th>Email</th><th>Linux</th><th>Status</th><th>Approved By</th><th>Flags</th></tr>';
    for (var u of users) {
      var flags = [];
      if (u.can_approve_users) flags.push('users');
      if (u.can_approve_admins) flags.push('admins');
      if (u.can_approve_sudo) flags.push('sudo');
      html += '<tr><td>' + esc(u.display_name) + '</td><td>' + esc(u.email) + '</td><td>' +
        esc(u.linux_user || '\u2014') + '</td><td>' + esc(u.status) + '</td><td>' +
        esc(u.approved_by || '\u2014') + '</td><td>' + (flags.join(', ') || '\u2014') + '</td></tr>';
    }
    html += '</table>';
    container.innerHTML = html;
  } catch(e) { container.innerHTML = '<span class="empty">Error loading</span>'; }
}

window.approve = async function(email) {
  if (!confirm('Approve ' + email + '?')) return;
  await fetch('/api/admin/approve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email })
  });
  loadPending(); loadUsers();
};

window.deny = async function(email) {
  if (!confirm('Deny ' + email + '?')) return;
  await fetch('/api/admin/deny', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email })
  });
  loadPending(); loadUsers();
};

document.getElementById('pre-approve-btn').addEventListener('click', async function() {
  var text = document.getElementById('pre-emails').value.trim();
  if (!text) return;
  var emails = text.split(/[\n,]+/).map(function(e) { return e.trim(); }).filter(Boolean);
  await fetch('/api/admin/pre-approve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emails: emails })
  });
  document.getElementById('pre-emails').value = '';
  loadPending(); loadUsers();
});

loadPending();
loadUsers();
