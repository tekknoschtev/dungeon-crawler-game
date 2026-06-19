# Deploying the Dungeon Crawler

How this game is hosted: a Debian LXC on Proxmox runs the Colyseus server under
systemd; `cloudflared` in the same box exposes it at `https://dungeon.<domain>`
through a Cloudflare tunnel — no port-forwarding, no exposed home IP.

This doc is dungeon-specific. For the generic Proxmox + Cloudflare tunnel setup
(creating the LXC, moving DNS, installing `cloudflared`), see the TrackBoard
walkthrough in the `mini-conf` repo — this game just deploys *differently* from
TrackBoard in a few ways, all called out below.

## Architecture (why the deploy looks the way it does)

Unlike a typical single-process web app, this game is **two concerns served as
one**:

- **Colyseus server** (`server/`) — authoritative game state over WebSocket.
- **Phaser client** (`client/`) — a static bundle (`client/dist/`) that connects
  back to the server over `wss://`.

In production the **server also serves the built client** (see
`server/src/index.ts`: `express.static(client/dist)` mounted on Colyseus's own
Express app). So the whole game lives behind **one origin / one port (2567)** —
HTTP for the page plus the WebSocket upgrade for Colyseus, same host. That's why
there is exactly **one** Cloudflare route, not two.

The client's server URL is baked in **at build time** from `VITE_SERVER_URL`
(`client/src/config.ts`). In production that must be the public `wss://` host.

## One-time first deploy

Everything runs inside the LXC. The game runs as an unprivileged `dungeon` user.

### 1. Create the service user + deploy key

```sh
useradd -m -d /home/dungeon -s /bin/bash dungeon
sudo -u dungeon ssh-keygen -t ed25519 -N '' -f /home/dungeon/.ssh/id_ed25519
cat /home/dungeon/.ssh/id_ed25519.pub
```

Add that public key to **GitHub → repo → Settings → Deploy keys** (read-only is
fine). A deploy key is **repo-scoped and single-use** — generate a *fresh* key
per box; do not reuse another box's/app's key.

> **Gotcha:** clone and *every* build command must run **as the `dungeon` user**
> (`sudo -u dungeon …`). The key lives in `dungeon`'s home, so cloning as `root`
> fails with `Permission denied (publickey)` — root has no key. Building as root
> creates root-owned files under `dist/`/`node_modules/` that the `dungeon` user
> can't later overwrite (`EACCES` on the next build).

### 2. Clone + install + build

```sh
sudo -u dungeon git clone git@github.com:tekknoschtev/dungeon-crawler-game.git /opt/dungeon
chown -R dungeon:dungeon /opt/dungeon
cd /opt/dungeon

sudo -u dungeon npm run setup      # installs root + server + client (NOT plain `npm install`)
```

> **Gotcha:** this repo is **not** npm workspaces. Root `npm install` only
> installs the root's own deps — `tsc`/Phaser/Colyseus live in `server/` and
> `client/`. Use `npm run setup`, which installs all three.

### 3. Point the client at the public URL (build-time)

`.env.*` is gitignored, so create this on the box (substitute your domain):

```sh
sudo -u dungeon tee /opt/dungeon/client/.env.production <<'EOF'
VITE_SERVER_URL=wss://dungeon.YOURDOMAIN.com
EOF
```

`wss://` (not `ws://`) and the **public** host — it must exactly match the
Cloudflare hostname in step 5, since the client and server share one origin.

### 4. Build

```sh
sudo -u dungeon npm run build      # builds server, then client into client/dist/
```

### 5. Install + start the systemd service

```sh
cp /opt/dungeon/deploy/dungeon.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now dungeon
```

Prove it's alive locally — page + matchmaking on the one port:

```sh
curl -s localhost:2567/ | grep -o '<title>.*</title>'        # -> <title>Dungeon Crawler</title>
curl -s -X POST localhost:2567/matchmake/joinOrCreate/dungeon \
  -H 'content-type: application/json' -d '{}'                 # -> JSON seat reservation
```

### 6. Cloudflare route — one route, HTTP type

In the tunnel's **Published application routes** → add one:

| Field | Value |
|---|---|
| Subdomain | `dungeon` |
| Domain | `yourdomain.com` |
| Path | *(empty)* |
| Service Type | **`HTTP`** |
| Service URL | `localhost:2567` |

- **`HTTP`, not `HTTPS`** — the local server is plain http; Cloudflare adds TLS
  at the edge. Choosing HTTPS here yields a 502.
- **WebSockets ride the HTTP route automatically** on Cloudflare tunnels — no
  extra config. The client does HTTP matchmaking then a WS upgrade, both to the
  same origin through this one route.

Cloudflare creates the DNS CNAME on save. Within seconds
`https://dungeon.yourdomain.com` is live with a real cert.

## Updating to the latest from GitHub

The normal maintenance loop — pull, reinstall, rebuild, restart:

```sh
cd /opt/dungeon
sudo -u dungeon git pull --ff-only
sudo -u dungeon npm run setup       # picks up any new/changed dependencies
sudo -u dungeon npm run build       # rebuilds server + client (re-bakes VITE_SERVER_URL)
systemctl restart dungeon
```

> **`git pull` rejected — "local changes would be overwritten" on
> `server/package-lock.json`:** `npm run setup` can regenerate the lockfile in
> place on the box. It's a generated file and the committed version is
> authoritative, so discard the box's copy and pull again:
> ```sh
> sudo -u dungeon git checkout -- server/package-lock.json
> sudo -u dungeon git pull --ff-only
> ```

The client bundle has the server URL **baked in**, so a rebuild is required
after any change — and especially if you ever change the public hostname (also
update `client/.env.production` first).

## Logs & status

```sh
systemctl status dungeon
journalctl -u dungeon -f
journalctl -u cloudflared -f
```

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `Permission denied (publickey)` on clone | Cloning as `root`; clone as `sudo -u dungeon`. Or deploy key missing / reused from another repo (keys are single-use) — add a fresh one. |
| `tsc: not found` on build | Ran `npm install` instead of `npm run setup`; subpackage deps not installed. |
| `EACCES` writing `dist/…` on build | Root-owned build output from a build run as root. `rm -rf server/dist client/dist && chown -R dungeon:dungeon /opt/dungeon`, then build as `dungeon`. |
| 502 from Cloudflare | App down (`systemctl status dungeon`; `curl localhost:2567/`) **or** route Service Type set to HTTPS instead of HTTP. |
| Page loads but "Couldn't create a room" | WebSocket can't connect — `VITE_SERVER_URL` host ≠ the live hostname, or it's `ws://` not `wss://`. Fix `client/.env.production`, rebuild, restart. Check DevTools → Network → WS for the failing URL. |
| `git pull` rejected on `package-lock.json` | See the update section above — `git checkout --` the file, then pull. |
