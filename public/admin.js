(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = {
    loginScreen: $('loginScreen'), loginForm: $('loginForm'), pw: $('pw'), loginBtn: $('loginBtn'), loginErr: $('loginErr'),
    panel: $('panel'), logoutBtn: $('logoutBtn'),
    tabUsers: $('tabUsers'), tabChats: $('tabChats'), usersCard: $('usersCard'), chatsCard: $('chatsCard'),
    usersBody: $('usersBody'), usersEmpty: $('usersEmpty'), chatsBody: $('chatsBody'), chatsEmpty: $('chatsEmpty'),
    wipeBtn: $('wipeBtn'),
    chatModal: $('chatModal'), chatModalTitle: $('chatModalTitle'), chatModalBody: $('chatModalBody'), chatModalClose: $('chatModalClose'),
    pwModal: $('pwModal'), pwModalWho: $('pwModalWho'), pwNew: $('pwNew'), pwModalCancel: $('pwModalCancel'), pwModalSave: $('pwModalSave'), pwModalErr: $('pwModalErr'),
    toast: $('toast'),
  };
  const store = { get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} }, del: (k) => { try { sessionStorage.removeItem(k); } catch {} } };
  let adminToken = store.get('admin.token');
  let usersCache = [], pwTarget = null;
  let toastTimer = null;

  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 3200);
  }

  async function api(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminToken, ...body }) });
    let data = {};
    try { data = await r.json(); } catch {}
    if (!r.ok) {
      if (r.status === 401 && path !== '/api/admin/login') signOut('Your admin session ended. Please log in again.');
      throw new Error(data.error || `Something went wrong (${r.status}).`);
    }
    return data;
  }

  function showPanel() {
    el.loginScreen.classList.add('hidden');
    el.panel.classList.remove('hidden');
    loadUsers();
  }
  function signOut(message) {
    adminToken = null;
    store.del('admin.token');
    el.panel.classList.add('hidden');
    el.loginScreen.classList.remove('hidden');
    el.loginErr.textContent = message || '';
    el.pw.value = '';
    el.pw.focus();
  }

  el.loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    el.loginErr.textContent = '';
    el.loginBtn.disabled = true;
    try {
      const r = await api('/api/admin/login', { password: el.pw.value });
      adminToken = r.adminToken;
      store.set('admin.token', adminToken);
      el.pw.value = '';
      showPanel();
    } catch (err) { el.loginErr.textContent = err.message; }
    finally { el.loginBtn.disabled = false; }
  });

  el.logoutBtn.addEventListener('click', async () => {
    try { await api('/api/admin/logout', {}); } catch {}
    signOut('');
  });

  function fmt(ts) { return ts ? new Date(ts).toLocaleString() : '—'; }

  function setTab(tab) {
    const users = tab === 'users';
    el.tabUsers.classList.toggle('active', users);
    el.tabChats.classList.toggle('active', !users);
    el.usersCard.classList.toggle('hidden', !users);
    el.chatsCard.classList.toggle('hidden', users);
    if (users) loadUsers(); else loadChats();
  }
  el.tabUsers.addEventListener('click', () => setTab('users'));
  el.tabChats.addEventListener('click', () => setTab('chats'));

  async function loadUsers() {
    el.usersBody.innerHTML = '<tr><td colspan="6" class="muted">Loading…</td></tr>';
    try {
      const r = await api('/api/admin/users', {});
      usersCache = r.users;
      el.usersEmpty.classList.toggle('hidden', !!r.users.length);
      el.usersBody.innerHTML = r.users.map((u) => `
        <tr>
          <td>${esc(u.username)}</td>
          <td>${fmt(u.created)}</td>
          <td>${fmt(u.lastSeen)}</td>
          <td>${u.chats}</td>
          <td><span class="pill ${u.online ? 'on' : ''}">${u.online ? 'online' : 'offline'}</span></td>
          <td class="row-actions">
            <button data-pw="${u.id}">Set password</button>
            <button data-del="${u.id}" class="danger">Delete</button>
          </td>
        </tr>`).join('') || '';
    } catch (err) { el.usersBody.innerHTML = `<tr><td colspan="6" class="muted">${esc(err.message)}</td></tr>`; }
  }

  el.usersBody.addEventListener('click', (e) => {
    const pwId = e.target.getAttribute('data-pw');
    const delId = e.target.getAttribute('data-del');
    if (pwId) openPwModal(pwId);
    if (delId) deleteUser(delId);
  });

  async function deleteUser(id) {
    const u = usersCache.find((x) => x.id === id);
    if (!confirm(`Delete the account "${u ? u.username : id}" and every chat it's part of? This cannot be undone.`)) return;
    try { await api('/api/admin/deleteUser', { userId: id }); toast('Account deleted.'); loadUsers(); } catch (err) { toast(err.message); }
  }

  function openPwModal(id) {
    pwTarget = usersCache.find((x) => x.id === id);
    if (!pwTarget) return;
    el.pwModalWho.textContent = `For: ${pwTarget.username}`;
    el.pwNew.value = '';
    el.pwModalErr.textContent = '';
    el.pwModal.classList.remove('hidden');
    el.pwNew.focus();
  }
  el.pwModalCancel.addEventListener('click', () => el.pwModal.classList.add('hidden'));
  el.pwModal.addEventListener('click', (e) => { if (e.target === el.pwModal) el.pwModal.classList.add('hidden'); });
  el.pwModalSave.addEventListener('click', async () => {
    if (!pwTarget) return;
    el.pwModalErr.textContent = '';
    if (el.pwNew.value.length < 8) { el.pwModalErr.textContent = 'At least 8 characters.'; return; }
    el.pwModalSave.disabled = true;
    try {
      await api('/api/admin/setPassword', { userId: pwTarget.id, password: el.pwNew.value });
      toast(`Password changed for ${pwTarget.username}. They were logged out everywhere.`);
      el.pwModal.classList.add('hidden');
    } catch (err) { el.pwModalErr.textContent = err.message; }
    finally { el.pwModalSave.disabled = false; }
  });

  async function loadChats() {
    el.chatsBody.innerHTML = '<tr><td colspan="5" class="muted">Loading…</td></tr>';
    try {
      const r = await api('/api/admin/chats', {});
      el.chatsEmpty.classList.toggle('hidden', !!r.chats.length);
      el.chatsBody.innerHTML = r.chats.map((c) => `
        <tr>
          <td>${esc(c.members.join(' ↔ '))}</td>
          <td><span class="pill">${esc(c.status)}</span></td>
          <td>${c.messageCount}</td>
          <td>${fmt(c.updated)}</td>
          <td class="row-actions">
            <button data-view="${c.id}">View</button>
            <button data-delchat="${c.id}" class="danger">Delete</button>
          </td>
        </tr>`).join('') || '';
    } catch (err) { el.chatsBody.innerHTML = `<tr><td colspan="5" class="muted">${esc(err.message)}</td></tr>`; }
  }

  el.chatsBody.addEventListener('click', (e) => {
    const viewId = e.target.getAttribute('data-view');
    const delId = e.target.getAttribute('data-delchat');
    if (viewId) viewChat(viewId);
    if (delId) deleteChat(delId);
  });

  async function deleteChat(id) {
    if (!confirm('Delete this conversation for both people? This cannot be undone.')) return;
    try { await api('/api/admin/deleteChat', { chatId: id }); toast('Chat deleted.'); loadChats(); } catch (err) { toast(err.message); }
  }

  async function viewChat(id) {
    el.chatModalTitle.textContent = 'Loading…';
    el.chatModalBody.innerHTML = '';
    el.chatModal.classList.remove('hidden');
    try {
      const r = await api('/api/admin/chat', { chatId: id });
      el.chatModalTitle.textContent = r.chat.members.join(' ↔ ');
      el.chatModalBody.innerHTML = r.chat.messages.length
        ? r.chat.messages.map((m) => `
            <div class="bubble">
              <strong>${esc(r.chat.members[m.from === r.chat.members[0] ? 0 : 1] || '')}</strong><br>
              ${m.photo ? `<img src="${m.photo}" alt="photo">` : ''}
              ${m.text ? esc(m.text) : ''}
              <small>${fmt(m.ts)}</small>
            </div>`).join('')
        : '<p class="muted">No messages yet.</p>';
    } catch (err) { el.chatModalTitle.textContent = 'Error'; el.chatModalBody.textContent = err.message; }
  }
  el.chatModalClose.addEventListener('click', () => el.chatModal.classList.add('hidden'));
  el.chatModal.addEventListener('click', (e) => { if (e.target === el.chatModal) el.chatModal.classList.add('hidden'); });

  el.wipeBtn.addEventListener('click', async () => {
    const typed = prompt('This deletes every account and every conversation, for good.\n\nType DELETE EVERYTHING to confirm:');
    if (typed === null) return;
    if (typed !== 'DELETE EVERYTHING') { toast('Not confirmed — nothing was deleted.'); return; }
    el.wipeBtn.disabled = true;
    try { await api('/api/admin/wipe', { confirm: typed }); toast('Everything was deleted.'); loadUsers(); loadChats(); }
    catch (err) { toast(err.message); }
    finally { el.wipeBtn.disabled = false; }
  });

  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  if (adminToken) showPanel(); else el.pw.focus();
})();
