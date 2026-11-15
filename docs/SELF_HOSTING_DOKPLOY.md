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
```

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
- **Webhook URL** (optional, near-instant updates): `https://gym.example.com/api/integrations/whoop/webhook`.

Put the app's Client ID and Secret in the Environment tab (step 2), redeploy, then in openGym:
Settings → Integrations → WHOOP → Connect, from the browser. The first sync brings in the whole
history; see docs/INTEGRATIONS.md#whoop.

## 6. Cloudflare tunnel

In Cloudflare Zero Trust → Networks → Tunnels, give the tunnel a **public hostname**
`gym.example.com` whose service is `http://localhost:80` (Dokploy's Traefik on the Pi; use the
Pi's address instead of localhost when cloudflared runs elsewhere). Traefik then routes by the
hostname to openGym's `web`. Cloudflare serves HTTPS to the world, which passkeys and WHOOP's
webhooks both need.

## Backups and updates

- Everything lives in the `opengym-data` volume (Dokploy shows it as `<app>_opengym-data`): users,
  passkeys, every profile, the WHOOP history, uploads. Back it up with Dokploy's **Volume Backups**
  (Advanced → Volumes), or `docker run --rm -v <volume>:/data -v $PWD:/out alpine tar czf /out/opengym.tgz -C /data .`.
- **Auto Deploy** (General tab) rebuilds on every push to the branch; or deploy by hand.
- Moving from a `docker compose` install with `./data`: copy that folder's contents into the volume
  before the first start (stop the service, copy with the `docker run ... alpine` line above in
  reverse, start it).
