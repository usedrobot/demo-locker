# Deployment Templates

Self-host Demo Locker on your preferred platform using these configuration templates. The app is packaged as a single `standalone` Docker image: API + web UI + embedded SQLite database in one container, with a persistent volume for your data.

## Fly.io

Deploy to Fly.io with zero configuration beyond copying the config file.

**Setup:**
1. Copy `fly.toml` from this repository into your working directory.
2. Create a volume for data persistence: `fly volumes create data --size 3`
3. Deploy: `fly deploy`

Run these three commands in sequence:
```bash
fly launch --copy-config --no-deploy
fly volumes create data --size 3
fly deploy
```

This creates a shared-cpu-1x instance (512 MB RAM) that automatically scales to zero when idle. Your data persists in the `data` volume even when the instance shuts down.

**Cost note:** Fly.io no longer offers a true free tier. Expect approximately $2–5/month for this instance size, including the persistent volume.

Once deployed, open `https://<app-name>.fly.dev` in your browser. Your data lives in the volume — snapshot it via `fly volumes snapshots list` and `fly volumes snapshots create` to back up.

## Railway

Deploy to Railway from your GitHub repository.

**Initial setup:**
1. Connect your Railway project to this repository via the Railway dashboard.
2. Railway will automatically detect `railway.json` and begin building.

**Manual configuration steps:**
After the first build completes, two manual steps are required:

1. **Set Docker build target:** In the service settings, navigate to **Build** and set the Docker build target to `standalone`. (This tells Docker to use the zero-dependency image.)
2. **Attach volume:** In **Resources**, add a new volume, mount it at path `/data`, and set size to 3 GB.

**Cost note:** Railway operates on a hobby plan ($5/month minimum). Your app will consume approximately 2–3 GB of storage for the volume plus runtime compute.

Run exactly one instance/replica. The embedded database is single-process, and two containers sharing the same `/data` volume will corrupt it.

Once deployed, open the service URL shown in your Railway dashboard. Your data lives in the volume — use the Railway dashboard to snapshot or export it to back up.

## Coolify

Deploy to Coolify (self-hosted or managed) with Dockerfile or Docker Compose.

**Setup:**
1. In your Coolify dashboard, select **New Resource** and choose **Docker Compose** or **Dockerfile**.
2. Point to this repository and configure:
   - **Build target:** Set to `standalone`
   - **Port:** 3001
   - **Volume:** Create a persistent volume and mount it at `/data` (size 3 GB recommended)
3. Deploy.

Coolify automatically provisions HTTPS via its integrated reverse proxy — no manual certificate setup required. Your app is accessible at the URL provided by Coolify's dashboard.

Run exactly one instance/replica. The embedded database is single-process, and two containers sharing the same `/data` volume will corrupt it.

Your data lives in the volume — use Coolify's backup tools to snapshot the volume for disaster recovery.

---

## Data & Backups

All three platforms persist your demo library and user data in the `/data` volume. Regular snapshots are essential:
- **Fly.io:** `fly volumes snapshots create`
- **Railway:** Use the dashboard's resource backup tools
- **Coolify:** Use Coolify's volume backup feature

The embedded database is durable on its own, but volume snapshots protect against platform failures and accidental deletions.
