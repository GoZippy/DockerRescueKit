# Running DockerRescueKit as a systemd service

The shipped Docker image is the recommended way to run the backend. Use
these files if you want to run the built Node app directly on a Linux host
(Proxmox LXC, bare metal, Raspberry Pi).

## One-time setup

```bash
sudo useradd --system --home /var/lib/docker-rescue-kit --shell /usr/sbin/nologin drk
sudo usermod -aG docker drk           # socket access
sudo mkdir -p /var/lib/docker-rescue-kit /var/log/docker-rescue-kit /etc/docker-rescue-kit
sudo chown -R drk:drk /var/lib/docker-rescue-kit /var/log/docker-rescue-kit
```

Build and install the backend + UI:

```bash
npm ci
npm run build
sudo install -Dm755 packages/backend/dist/index.js /usr/lib/docker-rescue-kit/index.js
sudo cp -r packages/backend/dist/*     /usr/lib/docker-rescue-kit/
sudo cp -r packages/extension/dist     /usr/share/docker-rescue-kit/ui
```

Install the binary dependencies used by remote storage adapters:

```bash
sudo apt-get install restic rclone    # Debian/Ubuntu
# or:
sudo dnf install restic rclone        # Fedora
```

Install + enable the unit:

```bash
sudo install -Dm644 packaging/systemd/docker-rescue-kit.service \
  /etc/systemd/system/docker-rescue-kit.service
sudo systemctl daemon-reload
sudo systemctl enable --now docker-rescue-kit
```

The service binds `0.0.0.0:42880` by default. The first-run API key is
written to `/var/lib/docker-rescue-kit/secrets.json` and also printed to the
journal:

```bash
sudo journalctl -u docker-rescue-kit -o cat | grep 'API key'
```

## Overrides via /etc/docker-rescue-kit/drk.env

```ini
DRK_API_KEY=<fixed-key-if-you-prefer>
DRK_ENCRYPTION_KEY=<must-never-change-after-first-backup>
PORT=42880
```
