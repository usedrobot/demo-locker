# Host Your Music

What you need, what it costs, and three real ways to get your Demo Locker
on the internet.

## What you're setting up

Demo Locker runs as one program (a Docker container) and keeps everything
it needs in one folder (a "volume"). That folder holds your uploaded
tracks and the database that tracks playlists, comments, and shares —
together. Copy that folder somewhere safe and you've backed up your
entire music library, no separate database export required.

Three ways to put that program on the internet, cheapest first.

## Fastest start: the setup wizard

Not sure which path fits your situation? Run the wizard and answer a few
questions — it figures out the rest:

```bash
npx demo-locker
```

Prefer to do it by hand, or want to understand what's happening under the
hood first? The manual paths below walk through the same ground step by
step.

## Path 1: Free — an old laptop or Raspberry Pi at home

Good if you have a spare computer that can stay plugged in and turned on.

**1. Install Docker.** Docker is the program that runs Demo Locker in an
isolated box so it doesn't touch anything else on your machine. Get it
from [docker.com](https://www.docker.com/get-started/) — macOS and
Windows get "Docker Desktop," Linux users run:

```bash
curl -fsSL https://get.docker.com | sh
```

**2. Start Demo Locker.** This is the same command from the README:

```bash
docker run -d -v demolocker:/data -p 3001:3001 ghcr.io/usedrobot/demo-locker:latest
```

Open `http://localhost:3001` on the same machine. You're running — but
only your home network can see it so far.

**3. Get a public URL with Cloudflare Tunnel.** A tunnel is a piece of
software that opens a connection from your machine out to the internet,
so people can reach you without you opening any ports on your router.

Install `cloudflared` (Cloudflare's tunnel client):

```bash
brew install cloudflared          # macOS
```

For Linux and Windows, see
[Cloudflare's install instructions](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).

Start with a quick tunnel — no account needed, gives you a random,
temporary URL:

```bash
cloudflared tunnel --url http://localhost:3001
```

Cloudflare prints something like `https://random-words-1234.trycloudflare.com`.
Open that URL from your phone, off your home Wi-Fi, and your music plays.
That URL changes every time you restart the tunnel, which is fine for
testing but annoying to share around.

For a URL that doesn't change (and optionally your own domain), sign up
for a free Cloudflare account, then create a named tunnel following
[Cloudflare's named tunnel guide](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/).
That gets you something like `https://music.yourdomain.com` that stays
put across restarts.

**The honest caveats:**

- Your laptop has to stay on and awake. On macOS, run
  `caffeinate -s` in a terminal — `-s` stops the Mac from sleeping
  while it's plugged into power; keep the lid open and the charger
  connected. On Linux, disable sleep in your power settings (e.g.
  `systemctl mask sleep.target` on most distros).
- Your home internet's upload speed caps how many people can listen at
  once. A 320 kbps stream needs about 0.32 Mbit/s of upload bandwidth. A
  typical US home connection offers 10–20 Mbit/s up, so you can support
  roughly 30–60 simultaneous listeners before things start buffering.
  That's plenty for a band sharing demos with each other — it is not
  enough for a release-day crowd.

## Path 2: ~$5/month — a small cloud server (VPS)

A VPS ("virtual private server") is a small computer you rent that lives
in a data center and is always on — no laptop lid to worry about, no home
upload speed limit.

**1. Rent a box.** [Hetzner](https://www.hetzner.com/cloud/) (from about
€4/month) and [DigitalOcean](https://www.digitalocean.com/pricing/droplets)
(from $6/month) both sell small Linux servers by the month, cancel
anytime. Pick the cheapest Ubuntu option — Demo Locker doesn't need much
CPU or RAM.

**2. Log in.** Both providers email or show you the server's IP address
after you create it:

```bash
ssh root@your-server-ip
```

**3. Install Docker on the server:**

```bash
curl -fsSL https://get.docker.com | sh
```

**4. Start Demo Locker** — the exact same command as Path 1:

```bash
docker run -d -v demolocker:/data -p 3001:3001 ghcr.io/usedrobot/demo-locker:latest
```

Open `http://your-server-ip:3001` in a browser. Your music plays, from
anywhere, all the time — no tunnel, no laptop to babysit.

**5. Put a real domain in front of it (optional).** Buy a domain, then in
its DNS settings (DNS is the system that maps a domain name like
`example.com` to a server's IP address) add an "A record" pointing it at
your server's IP. Then install [Caddy](https://caddyserver.com/), a
web server that fetches free HTTPS certificates automatically:

```bash
caddy reverse-proxy --from music.example.com --to localhost:3001
```

Now `https://music.example.com` serves Demo Locker with a valid
padlock. If you'd rather not run Caddy, you can instead point your
domain at the server through Cloudflare's free proxy, which handles
HTTPS for you the same way it does for the tunnel in Path 1.

**The honest caveat:** a $5 VPS is one small computer. It handles a band
or a small label's worth of listeners fine, but the same bandwidth math
from Path 1 applies — cheap VPS plans usually cap around 1 Gbit/s of
shared network, and CPU limits will matter before that ceiling for
anything more than a modest audience.

## Path 3: One-click-ish — Fly.io or Railway

If you'd rather not touch a terminal on a server at all, deploy to a
platform-as-a-service (PaaS) — a host that builds and runs your container
for you from config files already in this repo.

See [docs/deploy-templates.md](deploy-templates.md) for step-by-step
instructions for Fly.io, Railway, and Coolify.

**The honest caveat:** these platforms change their pricing and free
allowances often, and as of this writing both Fly.io and Railway require
a credit card on file even for their cheapest tiers. Fly.io roughly
$2–5/month, Railway has a $5/month minimum, similar to the VPS path,
just with less server maintenance.

## How loud can this get?

Demo Locker is built for demos, not stadiums. Any of the three paths
above is fine for a solo artist, a band, or a small label sharing rough
mixes with collaborators.

Where it breaks down: a genuinely popular release, shared widely on the
day it drops. The bandwidth arithmetic from Path 1 doesn't change — one
320 kbps listener costs about 0.32 Mbit/s of upload. A home line saturates
around 30–60 listeners; a $5 VPS saturates somewhere in the low hundreds.
Past that, either path will slow to a crawl or fall over.

If that's the problem you're having, congratulations, and the fixes are:
a bigger server, a CDN (content delivery network — a service that caches
your files close to listeners so your server doesn't serve every request
directly) in front of it, or a hosted Demo Locker plan we manage for you
(coming).

## Backing up

Everything that matters lives in the `/data` volume — your tracks and
your database. Back it up with:

```bash
docker run --rm -v demolocker:/data -v $(pwd):/backup alpine tar czf /backup/demolocker-backup.tar.gz /data
```

That writes `demolocker-backup.tar.gz` into your current folder. Keep a
copy somewhere off the machine — a cloud drive, an external disk,
wherever you'd trust with the only copy of your masters.

To restore onto a fresh install, create a new volume and untar the
backup into it:

```bash
docker run --rm -v demolocker:/data -v $(pwd):/backup alpine tar xzf /backup/demolocker-backup.tar.gz -C /
```

Then start Demo Locker normally — your tracks, playlists, and comments
are all back.
