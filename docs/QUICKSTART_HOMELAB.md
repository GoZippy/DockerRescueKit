# Quick Start: Docker Backup for Homelabbers

Get your homelab backed up in 15 minutes. No credit card. Forever free.

## What You'll Need

- Docker Desktop or Docker Engine running
- A NAS, USB drive, or spare disk for backups
- 10 MB disk space for the service itself

## 5-Minute Install

### Option A: Docker Compose (Easiest)

```bash
# 1. Create directory
mkdir -p ~/docker-backup
cd ~/docker-backup

# 2. Create docker-compose.yml
cat > docker-compose.yml <<'EOF'
version: '3.8'
services:
  backup:
    image: docker/backup-service:latest
    restart: always
    ports:
      - "127.0.0.1:42880:42880"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - backup-db:/app/data
      - ./backups:/backups
    environment:
      - BACKUP_PATH=/backups
      - NODE_ENV=production

volumes:
  backup-db:
EOF

> **Important: DOCKER_GID (Linux/macOS only)**
>
> On Linux/macOS, you **MUST** pass your host's docker group GID before
> `docker compose up` or `/api/docker` will return *"Docker offline"* and
> nothing will work. The container's `drk` user needs to be a member of
> the docker group that owns `/var/run/docker.sock` on your host.
>
> Find your host's docker GID:
> ```bash
> getent group docker | cut -d: -f3          # Linux
> dscl . -read /Groups/docker PrimaryGroupID  # macOS
> ```
>
> Then either:
>
> - `export DOCKER_GID=<that-number>` before `docker compose up`, **or**
> - Edit `docker-compose.yml`'s `group_add: ["${DOCKER_GID:-999}"]` line and
>   replace `999` with your value.
>
> The default `999` works on most Debian/Ubuntu hosts. Synology/QNAP often
> use `100`; some Debian variants use `998`; Docker Desktop on macOS varies
> per release. When in doubt, check.

# 3. Start the service
docker-compose up -d

# 4. Grab your API key (printed on first start, persisted to data/secrets.json)
docker logs drk 2>&1 | grep 'API key'
# → [Secrets] API key: <your-generated-key>

# 5. Check status (auth required for /api/*)
curl -H "x-api-key: <your-key>" http://localhost:42880/api/status

# 6. Or just hit the unauthenticated liveness probe
curl http://localhost:42880/healthz
# → {"status":"ok","uptime":12.3}
```

> **Heads up:** pre-release builds shipped with a hardcoded default API key.
> That is gone. The first start now generates a random key and prints it once.
> If you lose it, `cat data/secrets.json` or regenerate from the UI Settings panel.

### Option B: Command Line (No UI)

```bash
# 1. Clone repo
git clone https://github.com/docker/docker-backup-service.git
cd docker-backup-service

# 2. Install
npm install && npm run build

# 3. Start
npm run start:backend &

# 4. Create your first backup policy
docker backup policy create homelab \
  --containers $(docker ps --format "{{.Names}}" | paste -sd,) \
  --schedule "0 2 * * *" \
  --retention days=7 \
  --destination local://./backups
```

## First Backup

```bash
# List your containers
docker ps

# Run backup now
docker backup run homelab --now

# Check history
docker backup history homelab

# Restore if needed
docker backup restore homelab --latest
```

## Advanced: Backup to NAS

### Proxmox + Ceph

```bash
# 1. SSH to Proxmox node, export Ceph via NFS
pvesh create /storage \
  --content images,rootdir \
  --type nfs \
  --content_type rbd \
  --path /mnt/ceph-export

# 2. Mount on Docker host
sudo mkdir -p /mnt/ceph
sudo mount -t nfs proxmox.local:/mnt/ceph-export /mnt/ceph

# 3. Create policy
docker backup policy create ceph-backup \
  --containers '*' \
  --schedule "0 */6 * * *" \
  --retention count=28 \
  --destination local:///mnt/ceph
```

### TrueNAS

```bash
# 1. TrueNAS GUI → Sharing → SMB
#    Create share: docker-backups

# 2. Mount on Docker host
sudo mount -t cifs //truenas.local/docker-backups /mnt/nas \
  -o username=admin,password=secret

# 3. Create policy
docker backup policy create nas-backup \
  --containers '*' \
  --schedule "0 2 * * *" \
  --retention days=14 \
  --destination local:///mnt/nas
```

### Unraid

```bash
# 1. Unraid GUI → Shares → Add Share
#    Name: docker-backups
#    Use cache-pool (faster)

# 2. Mount
sudo mount -t cifs //unraid.local/docker-backups /mnt/unraid \
  -o username=root,password=secret

# 3. Create policy (all containers with 7-day retention)
docker backup policy create unraid-backup \
  --containers '*' \
  --schedule "0 3 * * *" \
  --retention days=7 \
  --destination local:///mnt/unraid
```

## Open Backup UI (Pro Tier)

Docker Desktop Extension coming soon. For now, use CLI or curl:

```bash
KEY=$(cat ./data/secrets.json | jq -r .apiKey)

# Get all policies
curl -H "x-api-key: $KEY" http://localhost:42880/api/policies

# Get backup history
curl -H "x-api-key: $KEY" http://localhost:42880/api/policies/<policy-id>/history

# Run backup manually
curl -X POST -H "x-api-key: $KEY" http://localhost:42880/api/policies/<policy-id>/run
```

## Multi-Node Homelab

Backup **from** Docker node 1 **to** NAS shared by all nodes:

```bash
# On Docker host 1:
docker backup policy create cluster-backup \
  --containers 'node1-*' \
  --schedule "0 2 * * *" \
  --retention count=7 \
  --destination local:///mnt/shared-nas

# NAS is shared across all nodes (high availability)
```

## Disaster Recovery

If a container crashes:

```bash
# 1. Check backup exists
docker backup list

# 2. Restore to latest
docker backup restore homelab --latest

# 3. Done. All containers + volumes restored.
```

If **entire Docker host** dies:

```bash
# 1. Fresh install Docker on new host
# 2. Restore from backup
docker backup restore homelab --latest

# 3. All data restored, same state as backup time
```

## Automation

### Run backups via cron (auto)

Policies run automatically on schedule. But you can also trigger manually:

```bash
# Backup via cron
(crontab -l 2>/dev/null; echo "0 2 * * * docker backup run homelab") | crontab -

# Or systemd timer
sudo tee /etc/systemd/timers.target.wants/docker-backup.timer > /dev/null <<EOF
[Unit]
Description=Docker Backup Timer

[Timer]
OnCalendar=daily
OnCalendar=02:00

[Install]
WantedBy=timers.target
EOF
```

### Notifications

```bash
# Policy with Slack notification (Pro tier)
docker backup policy create homelab-slack \
  --containers '*' \
  --schedule "0 2 * * *" \
  --retention days=7 \
  --destination local://./backups \
  --notification slack://hooks.slack.com/services/YOUR/WEBHOOK

# Notified on success/failure
```

## Storage Tips

**Space calculation:**
```
4 containers × average 2GB per container = 8GB per backup
× 7 daily backups = 56GB/week

Solution: 500GB disk = ~2 months retention
```

**Optimize:**
```bash
# Use compression (Pro tier)
docker backup policy update homelab \
  --compression zstd-fast

# Store on fast storage locally (NAS cache pool)
# Archive old backups to slow storage (USB pool)
```

## Monitoring with Uptime Kuma

Point Uptime Kuma at the unauthenticated `/healthz` endpoint — no API
key needed:

```
Monitor Type:        HTTP(s)
Friendly Name:       Docker Rescue Kit
URL:                 http://docker-host.local:42880/healthz
Heartbeat Interval:  60 seconds
Retries:             2
Accepted Status:     200-299
Keyword (optional):  "ok"
```

Add a second monitor on `/metrics` if you want to scrape Prometheus
counters via Kuma's keyword check (e.g. alert when `drk_backups_failed`
crosses a threshold).

## Troubleshooting

**Backup failing?**
```bash
# Check logs
docker logs docker-backup

# Verify storage accessible
ls -la /mnt/nas  # or wherever you're backing up

# Test manually
docker exec docker-backup npm run test:backup
```

**Not seeing containers?**
```bash
# Ensure socket mounted
docker exec docker-backup ls -la /var/run/docker.sock

# Verify Docker API accessible
curl -s --unix-socket /var/run/docker.sock http://d/v1.40/containers/json | jq .
```

**Restore failing?**
```bash
# Check backup integrity
docker backup verify homelab --backup-id xyz

# Restore with dry-run first
docker backup restore homelab --latest --dry-run

# Then restore for real
docker backup restore homelab --latest
```

## Next Steps

- **Join community:** GitHub Discussions
- **Share your setup:** Reddit r/homelab, r/selfhosted
- **Upgrade to Pro:** When you need managed backups ($25/month)
- **Contribute:** Add storage adapter (Proxmox API, Backblaze B2, etc.)

## FAQ

**Q: Will this backup my entire VM?**
A: No, just Docker containers/volumes/images. Use Proxmox snapshots for full VM backup.

**Q: Can I backup to cloud for free?**
A: Not in free tier. Pro tier ($25/month) includes 100GB S3.

**Q: What if my NAS dies?**
A: Backups on NAS are protected by NAS redundancy (RAID/Ceph). For offsite, upgrade to Pro tier.

**Q: Can I backup containers running on different hosts?**
A: Not yet. Roadmap: Multi-host orchestration (Q3 2025).

**Q: How long until my backups are deleted?**
A: Retention policy controls (default: 7 days). You can set any value.

---

**Questions?** Join our community: https://github.com/docker/docker-backup-service/discussions

**Found a bug?** Report here: https://github.com/docker/docker-backup-service/issues

**Ready for Pro?** https://docker.com/backup-service/pro

---

Happy backing up! 🎉
