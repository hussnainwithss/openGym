# openGym on Dokploy (fork)

This fork deploys to [Dokploy](https://dokploy.com) as a Compose service built from this
repository, with `docker-compose.dokploy.yml`. These steps assume Dokploy on a Raspberry Pi (arm64)
and a Cloudflare tunnel in front of it; anything else is the same apart from step 6.

Why a separate compose file: Dokploy clones the repository afresh on every deploy, so the `./data`
folder of `docker-compose.yml` would be emptied each time. The Dokploy file keeps the data in a named
volume, builds the images here (the published images do not have the WHOOP integration), and leaves
the port to Dokploy's domain routing.

## 1. Create the service

Dokploy → your project → **Create Service** → **Compose**.

- **Provider:** GitHub (or Git), repository `hussnainwithss/openGym`, branch `feat/whoop-integration`
  (or `main` once merged there).
- **Compose path:** `./docker-compose.dokploy.yml`
- **Compose type:** Docker Compose.

## 2. Environment

**Environment** tab. Dokploy writes these to `.env` next to the compose file, which the `api`
service reads. Replace `gym.example.com` with your hostname.

```
ORIGIN=https://gym.example.com
RP_ID=gym.example.com
RP_NAME=openGym

# WHOOP (docs/INTEGRATIONS.md#whoop)
INTEGRATIONS=whoop
WHOOP_CLIENT_ID=
WHOOP_CLIENT_SECRET=

# Behind Cloudflare: record the visitor's address, not Cloudflare's (single quotes included)
CF_CONNECTING_IP='$http_cf_connecting_ip'

# Optional
ADMIN_UIDS=          # your Settings → Account → Account ID: the admin dashboard
INVITE_ONLY=1        # new profiles need an invite code from that dashboard
ALLOW_GUEST=0        # no "Continue without account"
AUDIT_IP=net         # IP addresses in the activity log (net: the /24 only; full: whole address)
MCP=on               # remote MCP for AI assistants, see "Remote MCP" below
```

The API listens on port 3080, not upstream's 3000 (`API_PORT` changes it): a host firewall that
guards Dokploy's own UI on port 3000 (for example rules in Docker's `DOCKER-USER` chain that admit
only Tailscale and the LAN) also drops the web container's calls to an API on 3000. `TRUST_PROXY=1`
is set in the compose file already. After changing anything here, **Deploy** (a restart keeps the
old environment).

`RP_ID` is the bare hostname and `ORIGIN` the full https address of the same host: passkeys are bound
to it, so set them once and keep them (changing them later signs everyone out of their passkeys).
Other options (admins, invite-only, password sign-in, backups) are in `.env.example` and
docs/SELF_HOSTING.md.

## 3. Domain

**Domains** tab → **Add Domain**:

- **Host:** `gym.example.com`
- **Service:** `web`, **Container port:** `80`, **Path:** `/`
- **HTTPS:** off when Cloudflare terminates TLS for the tunnel (step 6); on, with Let's Encrypt, if
  the Pi is reachable directly on ports 80 and 443.

## 4. Deploy

**Deploy**. The first build runs on the Pi and takes a while: the web image builds the app with
Vite, which wants about 2 GB of memory. On a Pi with less, add swap first (for example 2 GB) or the
build is killed. Later deploys reuse the cached layers.

Check `https://gym.example.com/api/health` answers, then open the site and create your account with
a passkey.

## 5. WHOOP

On the WHOOP Developer Dashboard (https://developer-dashboard.whoop.com), in your app:

- **Redirect URL:** `https://gym.example.com/api/integrations/oauth/callback`, exactly.
- **Scopes:** read:recovery, read:cycles, read:workout, read:sleep, read:profile, read:body_measurement.
- **Webhook URL** (optional, near-instant updates): `https://gym.example.com/api/integrations/whoop/webhook`,
  model version **v2** (the handler takes v2's UUID ids). WHOOP sends one only when something new is
  scored; there is no test call. Workouts, sleep and recovery come this way; cycles (strain) and
  body weight only by the 15-minute poll. Cloudflare's Bot Fight Mode or a WAF rule must not
  challenge that path; Security → Events shows it if it does.

Put the app's Client ID and Secret in the Environment tab (step 2), redeploy, then in openGym:
Settings → Integrations → WHOOP → Connect, from the browser. The first sync brings in the whole
history; see docs/INTEGRATIONS.md#whoop.

## 6. Cloudflare tunnel

In Cloudflare Zero Trust → Networks → Tunnels, give the tunnel a **public hostname**
`gym.example.com` whose service is `http://localhost:80` (Dokploy's Traefik on the Pi; use the
Pi's address instead of localhost when cloudflared runs elsewhere). Traefik then routes by the
hostname to openGym's `web`. Cloudflare serves HTTPS to the world, which passkeys and WHOOP's
webhooks both need.

## Remote MCP

The compose file has an `mcp` service (docs/MCP_REMOTE.md): an AI assistant reads, and if you
allow it changes, your training through a scoped token. Set `MCP=on` in the Environment tab and
Deploy; then in Claude, Connectors → add a custom connector `https://gym.example.com/mcp` and sign in
with openGym, picking what it may see (WHOOP recovery & sleep is its own category). The Cloudflare
tunnel needs nothing new; Cloudflare Access, Bot Fight Mode or a WAF challenge on `/mcp`,
`/.well-known/` or `/api/oauth/` would stop the assistant's servers from connecting.

## Backups and updates

- Everything lives in the `opengym-data` volume (Dokploy shows it as `<app>_opengym-data`): users,
  passkeys, every profile, the WHOOP history, uploads, and `secret`, which seals the WHOOP tokens
  (restore the two together). Back it up with Dokploy's **Volume Backups**
  (Advanced → Volumes), or `docker run --rm -v <volume>:/data -v $PWD:/out alpine tar czf /out/opengym.tgz -C /data .`.
- **Auto Deploy** (General tab) rebuilds on every push to the branch; or deploy by hand.
- Moving from a `docker compose` install with `./data`: copy that folder's contents into the volume
  before the first start (stop the service, copy with the `docker run ... alpine` line above in
  reverse, start it).
