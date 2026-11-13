'use strict';
/*
 * Chat v3: v2's accounts/search/requests, plus photo messages, reply-to, and
 * one-to-one video/audio calls. Zero dependencies.
 *   node server.js            -> http://localhost:3000
 *   PORT=8080 node server.js
 *   DATA_FILE=/path/data.json node server.js   (where everything is stored)
 *   TRUST_PROXY=1             (set when behind Render/another proxy so rate limits see the real IP)
 *   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 *                             (optional) store data in a free Upstash Redis database instead of a
 *                             file. Needed on hosts with no persistent disk, e.g. Render's free plan.
 *
 * Realtime uses Server-Sent Events (server -> browser) plus plain POST requests
 * (browser -> server), so it works through most proxies and hosts.
 *
 * Photos: the browser compresses the image before sending; it is stored as a data URL
 * inside the message itself (no separate file storage, no third service). This is fine
 * for a small number of friends on a free database, but is not built to hold thousands
 * of photos — see the README.
 *
 * Calls: audio/video is peer-to-peer (WebRTC) and never touches this server. The server
 * only relays the short setup messages (offer/answer/ICE candidates) between the two
 * phones over the same realtime stream used for chat. Without a TURN relay server, calls
 * may fail to connect on some mobile networks — see the README.
 *
 * Data: { rooms, users, chats }. `rooms` is the old v1 data (file mode only); v3 keeps it
 * untouched in the file but does not use it.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const TRUST_PROXY = !!process.env.TRUST_PROXY && process.env.TRUST_PROXY !== '0';

const MAX_TEXT = 4000;           // characters per message
const MAX_PHOTO = 420000;        // characters of a photo's data URL (~310KB of image data)
const MAX_BODY = 480 * 1024;     // bytes per request (big enough for one photo message)
const HISTORY_LIMIT = 500;      // messages sent when a chat is opened
const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const USE_REDIS = !!(REDIS_URL && REDIS_TOKEN);
const MAX_STORED = Number(process.env.MAX_STORED) || (USE_REDIS ? 2000 : 20000); // messages kept per chat
const MAX_TOKENS_PER_USER = 10; // devices signed in at once per person
const MAX_PENDING_OUT = 30;     // connection requests a person can have waiting
const USERNAME_RE = /^[a-z0-9_.]{3,20}$/;

/* ------------------------------------------------------------------ storage */

let db = {};
function normalizeDb() {
  if (!db || typeof db !== 'object') db = {};
  if (!db.rooms || typeof db.rooms !== 'object') db.rooms = {};   // v1 data, kept as is
  if (!db.users || typeof db.users !== 'object') db.users = {};   // id -> user
  if (!db.chats || typeof db.chats !== 'object') db.chats = {};   // id -> chat
}
if (!USE_REDIS) { try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { /* first run */ } }
normalizeDb();

/* --- remote storage: Upstash Redis over its REST API (plain fetch, no packages).
   One key per user ("u:<id>") and per chat ("c:<id>"), plus the sets "users" / "chats"
   listing the ids. Only records that changed since the last save are written. */
async function redis(commands) {
  const r = await fetch(REDIS_URL + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw new Error('Redis HTTP ' + r.status);
  const out = await r.json();
  for (const o of out) if (o && o.error) throw new Error('Redis: ' + o.error);
  return out.map((o) => o.result);
}

const persisted = new Map(); // redis key -> JSON string last written (or loaded)

async function loadRemote() {
  const [uids, cids] = await redis([['SMEMBERS', 'users'], ['SMEMBERS', 'chats']]);
  db = { rooms: {}, users: {}, chats: {} };
  for (const [ids, prefix, bucket] of [[uids, 'u:', db.users], [cids, 'c:', db.chats]]) {
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const [vals] = await redis([['MGET', ...chunk.map((id) => prefix + id)]]);
      vals.forEach((v, j) => {
        if (!v) return;
        bucket[chunk[j]] = JSON.parse(v);
        persisted.set(prefix + chunk[j], v);
      });
    }
  }
  normalizeDb();
}

let flushing = false, flushAgain = false;
async function flushRemote() {
  if (flushing) { flushAgain = true; return; }
  flushing = true;
  try {
    do {
      flushAgain = false;
      const cmds = [];
      const wrote = new Map(); // key -> string, or null when deleted
      const live = new Set();
      const consider = (prefix, set, id, rec) => {
        const key = prefix + id;
        live.add(key);
        let str = JSON.stringify(rec);
        // a single Redis request must stay under ~1 MB: drop the oldest messages of a huge chat
        while (str.length > 900000 && rec.messages && rec.messages.length > 50) {
          rec.messages.splice(0, Math.ceil(rec.messages.length * 0.1));
          str = JSON.stringify(rec);
        }
        if (persisted.get(key) === str) return;
        cmds.push(['SET', key, str]);
        if (!persisted.has(key)) cmds.push(['SADD', set, id]);
        wrote.set(key, str);
      };
      for (const [id, u] of Object.entries(db.users)) consider('u:', 'users', id, u);
      for (const [id, c] of Object.entries(db.chats)) consider('c:', 'chats', id, c);
      for (const key of persisted.keys()) {
        if (live.has(key)) continue;
        cmds.push(['DEL', key], ['SREM', key[0] === 'u' ? 'users' : 'chats', key.slice(2)]);
        wrote.set(key, null);
      }
      // send in batches so one request never gets too big
      for (let i = 0; i < cmds.length;) {
        let size = 0; const batch = [];
        while (i < cmds.length && (batch.length === 0 || (size + cmds[i].join('').length < 700000 && batch.length < 200))) {
          size += cmds[i].join('').length; batch.push(cmds[i++]);
        }
        await redis(batch);
      }
      for (const [k, v] of wrote) { if (v === null) persisted.delete(k); else persisted.set(k, v); }
    } while (flushAgain);
  } finally { flushing = false; }
}

function flushFile() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DATA_FILE);
}

let saveTimer = null;
function flush() { // file mode: synchronous; Redis mode: returns a promise
  clearTimeout(saveTimer);
  saveTimer = null;
  return USE_REDIS ? flushRemote() : flushFile();
}
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    Promise.resolve().then(flush).catch((e) => {
      console.error('save failed:', e.message);
      setTimeout(save, 5000).unref(); // try again shortly
    });
  }, USE_REDIS ? 1000 : 250);
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newId = () => crypto.randomBytes(8).toString('hex');

/* in-memory indexes, rebuilt from the stored data on start */
const byName = new Map();     // username -> user
const tokenIndex = new Map(); // sha(token) -> userId   (tokens are stored only as hashes)
const userChats = new Map();  // userId -> Set(chatId)
function indexChat(chat) {
  for (const id of chat.members) {
    let s = userChats.get(id);
    if (!s) userChats.set(id, (s = new Set()));
    s.add(chat.id);
  }
}
function buildIndexes() {
  byName.clear(); tokenIndex.clear(); userChats.clear();
  for (const u of Object.values(db.users)) {
    byName.set(u.username, u);
    for (const h of u.tokens) tokenIndex.set(h, u.id);
  }
  for (const c of Object.values(db.chats)) indexChat(c);
}
buildIndexes();

function auth(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const hash = sha(token);
  const id = tokenIndex.get(hash);
  const user = id && db.users[id];
  return user ? { user, hash } : null;
}

async function hashPw(pw, salt) { return (await scrypt(pw, salt, 32)).toString('hex'); }
async function checkPw(pw, user) {
  const a = Buffer.from(await hashPw(pw, user.salt), 'hex');
  const b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const DUMMY_USER = { salt: 'x'.repeat(32), hash: '0'.repeat(64) }; // equal work when the username doesn't exist

function issueToken(user) {
  const token = crypto.randomBytes(24).toString('hex');
  const hash = sha(token);
  user.tokens.push(hash);
  tokenIndex.set(hash, user.id);
  while (user.tokens.length > MAX_TOKENS_PER_USER) tokenIndex.delete(user.tokens.shift());
  save();
  return token;
}

/* ------------------------------------------------------------ rate limiting */

const buckets = new Map(); // key -> { count, reset }
function hit(key, limit, windowMs) { // true while still allowed
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset <= now) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.count++;
  return b.count <= limit;
}
const blocked = (key, limit) => { const b = buckets.get(key); return !!b && b.reset > Date.now() && b.count >= limit; };
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k); }, 60 * 1000).unref();

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress || 'unknown';
}

const LOGIN_FAILS_IP = 10, LOGIN_FAILS_USER = 10, LOGIN_WINDOW = 10 * 60 * 1000;
const SIGNUPS_PER_IP = 8, SIGNUP_WINDOW = 60 * 60 * 1000;

/* ----------------------------------------------------------- live clients */

const clients = new Map(); // userId -> Set<res>
const conns = (userId) => clients.get(userId) || new Set();
const isOnline = (userId) => conns(userId).size > 0;
const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function emit(userId, event, data) {
  const payload = sse(event, data);
  for (const res of conns(userId)) res.write(payload);
}

/* ------------------------------------------------------------ chat helpers */

const otherId = (chat, userId) => chat.members.find((id) => id !== userId);

function findChat(a, b) {
  for (const id of userChats.get(a) || []) {
    const c = db.chats[id];
    if (c && c.members.includes(b)) return c;
  }
  return null;
}

// What one person sees of a chat. Pending/declined chats reveal no presence info.
function summary(chat, viewerId) {
  const peer = db.users[otherId(chat, viewerId)];
  const active = chat.status === 'active';
  const last = chat.messages[chat.messages.length - 1];
  let unread = 0;
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const m = chat.messages[i];
    if (m.from === viewerId) continue;
    if (m.seen) break;
    unread++;
  }
  return {
    id: chat.id,
    // the person who was declined keeps seeing "pending", so they can't tell
    status: chat.status === 'declined' && viewerId === chat.requester ? 'pending' : chat.status,
    requester: chat.requester,
    peer: { id: peer.id, username: peer.username, online: active && isOnline(peer.id), lastSeen: active ? peer.lastSeen : null },
    last: last ? { text: last.photo ? '' : last.text.slice(0, 120), photo: !!last.photo, ts: last.ts, from: last.from } : null,
    unread,
    updated: last ? last.ts : chat.created,
  };
}

function emitChat(chat) { for (const id of chat.members) emit(id, 'chat', summary(chat, id)); }

function broadcastPresence(user) {
  for (const chatId of userChats.get(user.id) || []) {
    const chat = db.chats[chatId];
    if (!chat || chat.status !== 'active') continue;
    emit(otherId(chat, user.id), 'presence', { userId: user.id, online: isOnline(user.id), lastSeen: user.lastSeen });
  }
}

/* -------------------------------------------------------------------- http */

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; " +
    "style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
    "script-src 'self'; connect-src 'self' stun: turn: turns:; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}
const fail = (res, status, error) => json(res, status, { error });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const normUsername = (v) => (typeof v === 'string' ? v.trim().replace(/^@/, '').toLowerCase() : '');
const USERNAME_HELP = 'Username must be 3-20 characters: letters, numbers, "." or "_".';

/* ---------------------------------------------------------- api: accounts */

async function signup(req, res, b) {
  const ip = clientIp(req);
  if (!hit('signup:' + ip, SIGNUPS_PER_IP, SIGNUP_WINDOW)) return fail(res, 429, 'Too many new accounts from this network. Please try again later.');
  const username = normUsername(b.username);
  const password = typeof b.password === 'string' ? b.password : '';
  if (!USERNAME_RE.test(username) || /^[._]|[.]$|\.\./.test(username)) return fail(res, 400, USERNAME_HELP);
  if (password.length < 8 || password.length > 100) return fail(res, 400, 'Password must be at least 8 characters.');
  if (byName.has(username)) return fail(res, 409, 'That username is taken.');

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await hashPw(password, salt);
  if (byName.has(username)) return fail(res, 409, 'That username is taken.'); // someone won the race while hashing
  const user = { id: newId(), username, salt, hash, tokens: [], created: Date.now(), lastSeen: Date.now() };
  db.users[user.id] = user;
  byName.set(username, user);
  json(res, 200, { token: issueToken(user), username });
}

async function login(req, res, b) {
  const ip = clientIp(req);
  const username = normUsername(b.username);
  const password = typeof b.password === 'string' ? b.password : '';
  const ipKey = 'lf-ip:' + ip, userKey = 'lf-user:' + username;
  if (blocked(ipKey, LOGIN_FAILS_IP) || blocked(userKey, LOGIN_FAILS_USER)) {
    return fail(res, 429, 'Too many failed attempts. Please wait a few minutes and try again.');
  }
  if (!username || !password || password.length > 100) return fail(res, 400, 'Enter your username and password.');
  const user = byName.get(username);
  const ok = await checkPw(password, user || DUMMY_USER) && !!user;
  if (!ok) {
    hit(ipKey, LOGIN_FAILS_IP, LOGIN_WINDOW);
    hit(userKey, LOGIN_FAILS_USER, LOGIN_WINDOW);
    return fail(res, 401, 'Wrong username or password.');
  }
  json(res, 200, { token: issueToken(user), username: user.username });
}

/* ------------------------------------------------------------- api: stream */

function stream(req, res, url) {
  const a = auth(url.searchParams.get('token'));
  if (!a) return fail(res, 401, 'Not signed in.');
  const { user } = a;

  req.socket.setTimeout(0);
  req.socket.setKeepAlive(true);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...SECURITY_HEADERS,
  });
  res.write('retry: 2000\n\n');

  let set = clients.get(user.id);
  if (!set) clients.set(user.id, (set = new Set()));
  const wasOnline = set.size > 0;
  set.add(res);
  user.lastSeen = Date.now();

  const chats = [...(userChats.get(user.id) || [])].map((id) => db.chats[id]).filter(Boolean).map((c) => summary(c, user.id));
  res.write(sse('init', { me: { id: user.id, username: user.username }, chats }));
  if (!wasOnline) broadcastPresence(user);

  const heartbeat = setInterval(() => res.write(sse('ping', 1)), 25 * 1000);
  req.on('close', () => {
    clearInterval(heartbeat);
    set.delete(res);
    if (set.size === 0) {
      user.lastSeen = Date.now();
      save();
      broadcastPresence(user);
    }
  });
}

/* --------------------------------------------------------------- api: rest */

function memberChat(user, chatId) {
  const chat = typeof chatId === 'string' ? db.chats[chatId] : null;
  return chat && chat.members.includes(user.id) ? chat : null;
}

async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/stream') return stream(req, res, url);
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed.');

  const body = await readBody(req);
  if (url.pathname === '/api/signup') return signup(req, res, body);
  if (url.pathname === '/api/login') return login(req, res, body);

  const a = auth(body.token);
  if (!a) return fail(res, 401, 'Not signed in.');
  const { user } = a;

  switch (url.pathname) {
    case '/api/ping':
      return json(res, 200, { ok: true });

    /* ---- find people ---- */
    case '/api/search': {
      if (!hit('search:' + user.id, 40, 60 * 1000)) return fail(res, 429, 'Searching too fast. Slow down a little.');
      const q = normUsername(body.q).slice(0, 20);
      if (q.length < 2) return json(res, 200, { users: [] });
      const found = [];
      for (const u of byName.values()) {
        if (u.id === user.id) continue;
        const i = u.username.indexOf(q);
        if (i < 0) continue;
        found.push({ u, score: u.username === q ? 0 : i === 0 ? 1 : 2 });
      }
      found.sort((x, y) => x.score - y.score || x.u.username.length - y.u.username.length || (x.u.username < y.u.username ? -1 : 1));
      const users = found.slice(0, 10).map(({ u }) => {
        const chat = findChat(user.id, u.id);
        let relation = 'none';
        if (chat) {
          if (chat.status === 'active') relation = 'connected';
          else relation = chat.requester === user.id ? 'requested' : 'incoming';
        }
        return { username: u.username, relation, chatId: chat ? chat.id : null };
      });
      return json(res, 200, { users });
    }

    /* ---- connections ---- */
    case '/api/connect': {
      const target = byName.get(normUsername(body.username));
      if (!target || target.id === user.id) return fail(res, 404, 'No one with that username.');
      let chat = findChat(user.id, target.id);
      if (chat) {
        if (chat.status !== 'active' && chat.requester === target.id) { // they already asked us: connect
          chat.status = 'active';
          save();
          emitChat(chat);
        }
        return json(res, 200, { chat: summary(chat, user.id) });
      }
      let pending = 0;
      for (const id of userChats.get(user.id) || []) {
        const c = db.chats[id];
        if (c && c.status !== 'active' && c.requester === user.id) pending++;
      }
      if (pending >= MAX_PENDING_OUT) return fail(res, 429, 'You have too many requests waiting. Wait for some to be accepted first.');
      chat = { id: newId(), members: [user.id, target.id], status: 'pending', requester: user.id, created: Date.now(), messages: [], nextId: 1 };
      db.chats[chat.id] = chat;
      indexChat(chat);
      save();
      emitChat(chat);
      return json(res, 200, { chat: summary(chat, user.id) });
    }

    case '/api/respond': { // accept or decline a request someone sent me
      const chat = memberChat(user, body.chatId);
      if (!chat || chat.status === 'active' || chat.requester === user.id) return fail(res, 404, 'Request not found.');
      if (body.accept) { chat.status = 'active'; save(); emitChat(chat); }
      else { chat.status = 'declined'; save(); emit(user.id, 'chat', summary(chat, user.id)); }
      return json(res, 200, { chat: summary(chat, user.id) });
    }

    case '/api/cancel': { // take back a request I sent
      const chat = memberChat(user, body.chatId);
      if (!chat || chat.status === 'active' || chat.requester !== user.id) return fail(res, 404, 'Request not found.');
      delete db.chats[chat.id];
      for (const id of chat.members) { const s = userChats.get(id); if (s) s.delete(chat.id); emit(id, 'chatRemoved', { chatId: chat.id }); }
      save();
      return json(res, 200, { ok: true });
    }

    /* ---- chatting ---- */
    case '/api/messages': {
      const chat = memberChat(user, body.chatId);
      if (!chat || chat.status !== 'active') return fail(res, 404, 'Chat not found.');
      return json(res, 200, { messages: chat.messages.slice(-HISTORY_LIMIT) });
    }

    case '/api/send': {
      const chat = memberChat(user, body.chatId);
      if (!chat || chat.status !== 'active') return fail(res, 403, 'You can chat once the request is accepted.');
      if (!hit('send:' + user.id, 60, 60 * 1000)) return fail(res, 429, 'You are sending messages too fast.');

      const text = typeof body.text === 'string' ? body.text.replace(/\r\n?/g, '\n').trim() : '';
      if (text.length > MAX_TEXT) return fail(res, 400, `Message is too long (max ${MAX_TEXT} characters).`);

      let photo = null;
      if (body.photo != null) {
        if (!hit('photo:' + user.id, 12, 60 * 1000)) return fail(res, 429, 'You are sending photos too fast.');
        photo = typeof body.photo === 'string' ? body.photo : '';
        if (!/^data:image\/(jpeg|png|webp);base64,[a-zA-Z0-9+/]+=*$/.test(photo)) return fail(res, 400, 'That photo could not be read.');
        if (photo.length > MAX_PHOTO) return fail(res, 413, 'That photo is too large.');
      }
      if (!text && !photo) return fail(res, 400, 'Message is empty.');

      let replyTo = null;
      if (body.replyTo != null) {
        const rid = Math.floor(Number(body.replyTo));
        if (chat.messages.some((m) => m.id === rid)) replyTo = rid; // silently dropped if it no longer exists
      }

      const message = { id: chat.nextId++, from: user.id, text, ts: Date.now(), seen: false };
      if (photo) message.photo = photo;
      if (replyTo) message.replyTo = replyTo;
      chat.messages.push(message);
      if (chat.messages.length > MAX_STORED) chat.messages.splice(0, chat.messages.length - MAX_STORED);
      user.lastSeen = Date.now();
      save();
      for (const id of chat.members) emit(id, 'msg', { chatId: chat.id, message });
      return json(res, 200, { message });
    }

    /* ---- calls: the server only relays these short setup messages; media is peer-to-peer ---- */
    case '/api/call': {
      const chat = memberChat(user, body.chatId);
      if (!chat || chat.status !== 'active') return fail(res, 403, 'You can call once the request is accepted.');
      const type = body.type;
      if (!['offer', 'answer', 'ice', 'end', 'busy', 'decline'].includes(type)) return fail(res, 400, 'Bad call message.');
      if (type === 'offer' && !hit('calloffer:' + user.id, 20, 60 * 1000)) return fail(res, 429, 'Too many call attempts. Wait a moment.');
      if (!hit('call:' + user.id, 300, 60 * 1000)) return fail(res, 429, 'Too many call messages.');
      const peerId = otherId(chat, user.id);
      if (!isOnline(peerId) && type === 'offer') return fail(res, 409, "They're not online right now.");
      emit(peerId, 'call', { chatId: chat.id, from: user.id, type, data: body.data ?? null });
      return json(res, 200, { ok: true });
    }

    case '/api/typing': {
      const chat = memberChat(user, body.chatId);
      if (chat && chat.status === 'active') emit(otherId(chat, user.id), 'typing', { chatId: chat.id, typing: !!body.typing });
      return json(res, 200, { ok: true });
    }

    case '/api/seen': {
      const chat = memberChat(user, body.chatId);
      if (!chat || chat.status !== 'active') return fail(res, 404, 'Chat not found.');
      const upTo = Math.floor(Number(body.upTo));
      if (!Number.isFinite(upTo) || upTo < 1) return fail(res, 400, 'Bad value.');
      let changed = false;
      for (let i = chat.messages.length - 1; i >= 0; i--) {
        const m = chat.messages[i];
        if (m.from === user.id || m.id > upTo) continue;
        if (m.seen) break; // everything older is already marked
        m.seen = true;
        changed = true;
      }
      if (changed) {
        save();
        for (const id of chat.members) emit(id, 'seen', { chatId: chat.id, by: user.id, upTo, unread: summary(chat, user.id).unread });
      }
      return json(res, 200, { ok: true });
    }

    case '/api/logout': {
      user.tokens = user.tokens.filter((h) => h !== a.hash);
      tokenIndex.delete(a.hash);
      save();
      return json(res, 200, { ok: true });
    }

    default:
      return fail(res, 404, 'Not found.');
  }
}

/* ------------------------------------------------------------ static files */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

/* ------------------------------------------------------------------ server */

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); return res.end('ok'); }
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) fail(res, e.status || 500, e.status ? e.message : 'Server error.');
    else res.end();
  }
});

async function shutdown() {
  // give the last writes a few seconds to reach storage before exiting
  try { await Promise.race([Promise.resolve(flush()), new Promise((r) => setTimeout(r, 8000))]); } catch { /* ignore */ }
  process.exit(0);
}

if (require.main === module) {
  (async () => {
    if (USE_REDIS) {
      try { await loadRemote(); buildIndexes(); console.log(`Loaded ${Object.keys(db.users).length} users and ${Object.keys(db.chats).length} chats from Redis.`); }
      catch (e) { console.error('Could not load data from Redis:', e.message); process.exit(1); } // never start empty by mistake
    }
    server.listen(PORT, () => {
      console.log('\nChat v3 is running:');
      console.log(`  http://localhost:${PORT}`);
      for (const list of Object.values(os.networkInterfaces())) {
        for (const i of list || []) if (i.family === 'IPv4' && !i.internal) console.log(`  http://${i.address}:${PORT}   (same Wi-Fi / network)`);
      }
      console.log(USE_REDIS ? '\nData is saved in Upstash Redis\n' : `\nData is saved in ${DATA_FILE}\n`);
    });
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  })();
}

module.exports = { server, flush };
