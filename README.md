# Our Chat v3

A real-time private chat where anyone can make an account, find people by username, and talk one-to-one.
No dependencies, just Node.js 18+.

## Run it

```bash
npm start            # or: node server.js
```

Open http://localhost:3000. The terminal also prints a "same Wi-Fi" address for phones.

## How it works

1. **Create an account** with a username (3-20 characters: letters, numbers, `.` `_`) and a password (8+ characters).
2. **Search** a username in the box at the top left and press **Connect**.
3. The other person sees it under **Requests** and taps **Accept** (or **Decline**).
4. Once accepted, you can chat. Nobody can message you before you accept.

Log in again from any device with the same username and password.

## Features

- Accounts with unique usernames, search, connection requests (accept / decline / cancel)
- Any number of conversations per person, newest first, with unread badges
- Instant delivery (Server-Sent Events), online / last seen, "typing...", sent and seen ticks
- **Photos:** pick an image, it's shrunk and compressed right in the browser, then sent as part of the message. Tap a photo to view it full-size.
- **Reply to a message:** drag/swipe a message sideways (or just hold and drag with a mouse) to quote it in your reply. Tap the quote to jump back to the original.
- **Audio and video calls:** one-to-one, started from the phone/video icons at the top of a conversation. The call itself goes directly between the two people's devices (WebRTC) and never passes through this server — the server only relays the short setup messages needed to connect the call.
- Messages saved on the server; history survives restarts
- Clickable links, Shift+Enter for a new line (on phones Enter is a new line)
- Unread count in the tab title, optional desktop notifications
- Works on phones: list and conversation switch like a native app, and the back button works

## About calls

- Calls need both people's browser open to Our Chat at the time, same as a doorbell: there is no ringing a closed tab or a sleeping phone.
- No TURN relay server is configured. Calls work on the same Wi-Fi and on most home/office internet. On some mobile networks (carrier-grade NAT, some corporate or campus Wi-Fi) a call may fail to connect — if that happens a lot, a free TURN server such as Metered.ca's free tier can be added; ask for it to be wired in.
- Camera/microphone access only works over HTTPS (or `localhost`), which Render and any tunnel already give you.
- Only one call at a time per conversation. If you call someone who's already on a call, they'll show as busy.

## About photos

- Photos are compressed in the browser (max ~1600px, JPEG) before sending, and capped at roughly 300KB each after compression.
- They're stored as part of the message itself — no separate file storage or third-party service, which keeps this at zero cost but is not meant to hold thousands of photos. See the storage notes below for the Upstash/Redis free-tier limits that apply.

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `DATA_FILE` | `./data.json` | Where everything is stored (file mode) |
| `TRUST_PROXY` | off | Set to `1` behind Render/another proxy so rate limits use the visitor's real IP |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | off | Store data in a free Upstash Redis database instead of a file (needed on Render's free plan) |

When the two Upstash variables are set the server uses Redis and ignores `DATA_FILE`. If Redis can't be reached when the server starts, it refuses to start rather than begin empty.

## Deploy free on Render (GitHub + Upstash)

Render's free plan has no persistent disk, so a file would be wiped every time the server sleeps or redeploys. Upstash gives you a free database (no credit card needed) that keeps your data.

1. **Upstash:** sign up at upstash.com, click **Create Database** (Redis), pick the region closest to Render's, and create it. On its page open the **REST API** section and copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
2. **GitHub:** create a new private repo and upload these files (`server.js`, `package.json`, `render.yaml`, `README.md`, `public/`).
3. **Render:** **New > Blueprint**, pick the repo. When asked, paste the two Upstash values. (Or **New > Web Service**: runtime Node, start command `node server.js`, plan Free, and add the three environment variables above.)
4. Open your `https://...onrender.com` address once it says **Live**.

Free-plan behaviour to expect:
- The server **sleeps after about 15 minutes with no visitors**, and the first visit afterwards takes 30-60 seconds to wake it. Chats and accounts are safe in Upstash.
- To keep it awake, point a free pinger such as UptimeRobot at `https://your-app.onrender.com/healthz` every 5 minutes.
- Free Upstash allows 500,000 commands a month. Each message uses about one write, so this is plenty for friends and family. Only the newest 2,000 messages per chat are kept on Redis (set `MAX_STORED` to change it).

## Upgrading from v1

v2 starts fresh: v1 rooms are not shown and everyone creates a new account. Use a new GitHub repo and a new Render service so v1 keeps running untouched.

## Privacy and security

- Passwords are stored hashed (scrypt). Sign-in tokens are stored only as hashes.
- Failed logins are limited per IP and per username; new accounts, searches and messages are rate limited.
- Search needs at least 2 characters and returns at most 10 usernames. Only usernames are visible to others.
- If someone declines your request, you keep seeing "Requested" and cannot re-send it.
- Messages are **not** end-to-end encrypted: they are readable text in `data.json` (or in your Upstash database), so whoever runs the server or owns that database can read them. Keep the Upstash token secret.
- No password reset exists yet, since accounts have no email. A forgotten password means a new account.

## Files

```
server.js          Backend (accounts, search, connections, realtime, storage)
public/index.html  Page structure
public/style.css   Look and layout
public/app.js      Browser logic
```

## Ideas for later

Block / report, delete account and change password, photo sharing, reactions, reply and delete messages, push notifications, profile pictures, a database instead of one JSON file (needed once there are thousands of users).
