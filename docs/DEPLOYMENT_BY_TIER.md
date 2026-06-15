---
title: Docker Backup Service - Deployment Guide
---

# Deployment Guides by Tier

## Cross-cutting: docker.sock access

The backend talks to Docker via `/var/run/docker.sock`. How it gains
permission depends on the host OS — get this wrong and you'll see
`EACCES` or `connect EACCES /var/run/docker.sock` on first start.

### Linux

The socket is owned by `root:docker` (group `docker`, GID typically 999
on Debian/Ubuntu, sometimes 998 on Arch, 100 on some Synology DSM /
QNAP firmware). The container needs that GID added as a supplementary
group so it can read the socket. The shipped `docker-compose.yml` reads
`DOCKER_GID` from the environment and applies it via `group_add`:

```bash
# One-shot — read the host's actual docker socket GID and pass it in
DOCKER_GID=$(stat -c %g /var/run/docker.sock) docker compose up -d

# Or persist it
echo "DOCKER_GID=$(stat -c %g /var/run/docker.sock)" >> .env
docker compose up -d
```

> **Synology / QNAP trap:** these vendors put the docker socket in
> group `users` (GID 100), not `docker`. The default `999` will hand
> you a permission denied. Always run the `stat` command above on the
> actual host before assuming the default.

### Windows / macOS (Docker Desktop)

Docker Desktop runs the daemon inside a VM and proxies the socket into
containers via a named-pipe shim. Permissions are managed by Docker
Desktop itself — `DOCKER_GID` is unused, `group_add` is a no-op, and
mounting `/var/run/docker.sock:/var/run/docker.sock` "just works".

```bash
# Same compose file, no env tweaks needed
docker compose up -d
```

---

## Reverse proxy with TLS

Port `42880` binds to `127.0.0.1` by default — safe, but unreachable
from outside the host. To expose it on the LAN or internet, front it
with a reverse proxy that terminates TLS.

### Caddy (simplest, automatic Let's Encrypt)

```caddy
# /etc/caddy/Caddyfile
backup.example.com {
    reverse_proxy 127.0.0.1:42880
    encode zstd gzip
    # Optional: mTLS / IP allowlist / basic_auth in front of the API key
}
```

```bash
sudo systemctl reload caddy
# Caddy fetches a cert from Let's Encrypt automatically.
```

### Traefik (compose label form)

If you already have Traefik running on the same docker engine as the
backend, add labels to the backend service:

```yaml
services:
  backup:
    image: ghcr.io/<you>/docker-rescue-kit:latest
    expose:
      - "42880"
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.drk.rule=Host(`backup.example.com`)"
      - "traefik.http.routers.drk.entrypoints=websecure"
      - "traefik.http.routers.drk.tls.certresolver=letsencrypt"
      - "traefik.http.services.drk.loadbalancer.server.port=42880"
    networks:
      - traefik-public
```

Either proxy preserves the `x-api-key` header by default — clients
authenticate exactly the same as if they were hitting the local port.

---

## Homelab / Free Tier

### Minimal Setup (Single Proxmox Node)

**Prerequisites:**
- Proxmox 7.0+
- Docker or LXC container runtime
- NAS or local storage

**Installation:**

```bash
# On your homelab Docker host
git clone https://github.com/docker/docker-backup-service.git
cd docker-backup-service
npm install
npm run build

# Create systemd service (optional auto-start)
sudo tee /etc/systemd/system/docker-backup.service > /dev/null <<EOF
[Unit]
Description=Docker Backup Service
After=docker.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=/opt/docker-backup-service
ExecStart=/usr/bin/node packages/backend/dist/index.js
Restart=always
RestartSec=10
User=docker-backup
Environment="NODE_ENV=production"
Environment="BACKUP_PATH=/mnt/backups"

[Install]
WantedBy=multi-user.target
EOF

sudo useradd -m -s /bin/false docker-backup
sudo chown -R docker-backup:docker-backup /opt/docker-backup-service
sudo systemctl daemon-reload
sudo systemctl enable --now docker-backup
```

**CLI Usage (No UI required):**

```bash
# Create backup policy
docker backup policy create homelab-daily \
  --containers my-app,my-db \
  --schedule "0 2 * * *" \
  --retention days=7 \
  --destination local:///mnt/backups

# Run backup now
docker backup policy run homelab-daily --now

# List backups
docker backup list

# Restore
docker backup restore homelab-daily --latest
```

### Homelab with Proxmox Ceph

**Architecture:**
```
Proxmox Node 1          Proxmox Node 2
├─ Ceph Monitor        ├─ Ceph OSD
├─ Ceph OSD            └─ Storage
├─ Docker LXC          
│  └─ Backup Service   Proxmox Node 3
└─ Ceph OSD            └─ Ceph OSD

Backup Service → NFS mount → Ceph RBD
```

**Setup:**

```bash
# 1. Export Ceph RBD pool via NFS (Proxmox terminal)
# SSH into Proxmox node and configure NFS export

# 2. Mount on Docker host
sudo mkdir -p /mnt/ceph-backup
sudo mount -t nfs 192.168.1.50:/ceph-docker-backups /mnt/ceph-backup

# 3. Verify mount
df -h | grep ceph-backup

# 4. Create policy targeting Ceph
docker backup policy create ceph-backup \
  --containers app-prod,db-prod \
  --schedule "0 */6 * * *" \
  --retention days=7 \
  --destination local:///mnt/ceph-backup

# 5. Proxmox automatically snapshots NFS daily
#    (configure in Proxmox GUI: VMs → Snapshots)
```

### Homelab with TrueNAS

**Setup:**

```bash
# 1. On TrueNAS: Create SMB share for backups
# TrueNAS GUI → Sharing → Windows (SMB)
# Share name: docker-backups
# Path: /mnt/tank/docker-backups

# 2. Mount on Docker host
sudo mkdir -p /mnt/nas
sudo mount -t cifs //192.168.1.100/docker-backups /mnt/nas \
  -o username=admin,password=secret

# 3. Add to /etc/fstab for auto-mount
sudo tee -a /etc/fstab > /dev/null <<EOF
//192.168.1.100/docker-backups /mnt/nas cifs username=admin,password=secret,uid=1000 0 0
EOF

# 4. Create policy
docker backup policy create nas-backup \
  --containers my-app \
  --schedule "0 2 * * *" \
  --retention count=7 \
  --destination local:///mnt/nas

# 5. TrueNAS snapshots NFS/SMB automatically
```

### Homelab with Unraid

**Setup:**

```bash
# 1. Unraid: Create share (Settings → Shares → Add Share)
# Share: docker-backups
# Pool: cache-pool (fast SSDs)

# 2. Mount on Docker host
sudo mount -t cifs //unraid.local/docker-backups /mnt/unraid \
  -o username=root,password=secret

# 3. Policy
docker backup policy create unraid-backup \
  --containers * \
  --schedule "0 3 * * *" \
  --retention days=14 \
  --destination local:///mnt/unraid

# Unraid parity protects backups
```

---

## Pro Tier / Small Business

### Self-Hosted Pro (BYOS)

**docker-compose.yml:**

```yaml
version: '3.8'

services:
  backup-service:
    image: docker/backup-service:pro
    restart: always
    container_name: docker-backup-pro
    
    ports:
      - "127.0.0.1:42880:42880"  # Localhost only
    
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - backup-db:/app/data
      - /mnt/nas-backups:/backups  # Your NAS mount
      - /etc/docker-backup/hooks:/app/hooks:ro  # Custom scripts
    
    environment:
      - NODE_ENV=production
      - LICENSE_KEY=${LICENSE_KEY}  # Set via .env
      - BACKUP_PATH=/backups
      - DB_PATH=/app/data/backups.db
      - LOG_LEVEL=info
      - MAX_POLICIES=unlimited
      - ENABLE_ENCRYPTION=true
    
    networks:
      - backup-net
    
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:42880/healthz"]
      interval: 30s
      timeout: 10s
      retries: 3
    
    depends_on:
      - backup-db
  
  backup-db:
    image: postgres:15-alpine
    restart: always
    container_name: docker-backup-db
    
    volumes:
      - backup-postgres:/var/lib/postgresql/data
    
    environment:
      - POSTGRES_PASSWORD=${DB_PASSWORD}
      - POSTGRES_DB=backup_service
    
    networks:
      - backup-net
    
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5

  # Reverse proxy (recommended)
  reverse-proxy:
    image: traefik:v2.10
    restart: always
    container_name: docker-backup-proxy
    
    ports:
      - "443:443"
      - "80:80"
    
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./traefik.yml:/traefik.yml:ro
      - ./certs:/certs  # SSL certificates
    
    networks:
      - backup-net
    
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.backup.rule=Host(`backup.yourdomain.com`)"
      - "traefik.http.routers.backup.service=backup"
      - "traefik.http.services.backup.loadbalancer.server.port=42880"

  # Optional: Prometheus for metrics
  prometheus:
    image: prom/prometheus:latest
    restart: always
    container_name: docker-backup-prometheus
    
    ports:
      - "9090:9090"
    
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - prometheus-data:/prometheus
    
    networks:
      - backup-net
    
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'

volumes:
  backup-db:
  backup-postgres:
  prometheus-data:

networks:
  backup-net:
    driver: bridge
```

**Setup:**

```bash
# 1. Create license and environment
cat > .env <<EOF
LICENSE_KEY=PRO-XXXX-XXXX-XXXX
DB_PASSWORD=$(openssl rand -base64 32)
EOF

# 2. Create certificate
mkdir -p certs
openssl req -x509 -newkey rsa:4096 -keyout certs/key.pem \
  -out certs/cert.pem -days 365 -nodes \
  -subj "/CN=backup.yourdomain.com"

# 3. Configure Traefik
cat > traefik.yml <<EOF
api:
  dashboard: true
  debug: true

entryPoints:
  http:
    address: ":80"
  https:
    address: ":443"

providers:
  docker:
    endpoint: "unix:///var/run/docker.sock"
    exposedByDefault: false

certificatesResolvers:
  letsencrypt:
    acme:
      email: admin@yourdomain.com
      storage: /certs/acme.json
      httpChallenge:
        entryPoint: http
EOF

# 4. Configure Prometheus
cat > prometheus.yml <<EOF
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'docker-backup'
    static_configs:
      - targets: ['localhost:42880']
EOF

# 5. Deploy
docker-compose up -d

# 6. Verify (healthz is unauthenticated, /api/* needs the key)
curl https://backup.yourdomain.com/healthz
curl -H "x-api-key: $(cat data/secrets.json | jq -r .apiKey)" \
     https://backup.yourdomain.com/api/status
```

### Pro Tier with Managed S3

**Environment (.env):**

```bash
LICENSE_KEY=PRO-MANAGED-XXXX
BACKUP_PATH=/backups
S3_ENABLED=true
S3_BUCKET=docker-backup-${USER_ID}
S3_REGION=us-east-1
S3_ENDPOINT=https://s3.docker.io  # Docker API endpoint
S3_ACCESS_KEY=your-docker-api-key
S3_SECRET_KEY=your-docker-api-secret
```

**Policy Configuration:**

```bash
# Create hybrid policy: Local + S3
docker backup policy create hybrid-backup \
  --containers my-app,my-db \
  --schedule "0 2 * * *" \
  --retention days=7 \
  --destination local:///mnt/nas \
  --secondary-destination s3://docker-backup-managed/backups \
  --secondary-schedule "0 4 1 * *" \
  --secondary-retention months=6
```

---

## Enterprise Tier

### Enterprise Self-Hosted (Air-gapped)

**Kubernetes Deployment:**

```yaml
---
apiVersion: v1
kind: Namespace
metadata:
  name: docker-backup-enterprise

---
apiVersion: v1
kind: ConfigMap
metadata:
  name: backup-config
  namespace: docker-backup-enterprise
data:
  NODE_ENV: "production"
  LOG_LEVEL: "info"
  BACKUP_PATH: "/backups"
  ENABLE_CLUSTERING: "true"
  ENABLE_RBAC: "true"
  ENABLE_AUDIT_LOG: "true"

---
apiVersion: v1
kind: Secret
metadata:
  name: backup-secrets
  namespace: docker-backup-enterprise
type: Opaque
stringData:
  LICENSE_KEY: "ENTERPRISE-SELF-HOSTED-XXXX"
  DB_PASSWORD: "{{ DB_PASSWORD_BASE64 }}"
  HSM_PIN: "{{ HSM_PIN_BASE64 }}"

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backup-service
  namespace: docker-backup-enterprise
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  
  selector:
    matchLabels:
      app: docker-backup
      tier: backend
  
  template:
    metadata:
      labels:
        app: docker-backup
        tier: backend
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "42880"
        prometheus.io/path: "/metrics"
    
    spec:
      serviceAccountName: backup-service
      
      initContainers:
        - name: migrate-db
          image: docker/backup-service:enterprise
          command: ["npm", "run", "migrate"]
          envFrom:
            - configMapRef:
                name: backup-config
            - secretRef:
                name: backup-secrets
      
      containers:
        - name: backup-service
          image: docker/backup-service:enterprise
          imagePullPolicy: IfNotPresent
          
          ports:
            - name: http
              containerPort: 42880
              protocol: TCP
            - name: metrics
              containerPort: 9090
              protocol: TCP
          
          env:
            - name: DOCKER_HOST
              value: "unix:///var/run/docker.sock"
          
          envFrom:
            - configMapRef:
                name: backup-config
            - secretRef:
                name: backup-secrets
          
          volumeMounts:
            - name: docker-socket
              mountPath: /var/run/docker.sock
              readOnly: true
            - name: backup-data
              mountPath: /backups
            - name: db-data
              mountPath: /app/data
            - name: audit-logs
              mountPath: /app/audit
          
          livenessProbe:
            httpGet:
              path: /healthz
              port: http
            initialDelaySeconds: 30
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 3
          
          readinessProbe:
            httpGet:
              path: /healthz
              port: http
            initialDelaySeconds: 20
            periodSeconds: 5
          
          resources:
            requests:
              cpu: "500m"
              memory: "512Mi"
            limits:
              cpu: "2000m"
              memory: "2Gi"
          
          securityContext:
            runAsNonRoot: false
            capabilities:
              drop:
                - ALL
              add:
                - NET_BIND_SERVICE
      
      volumes:
        - name: docker-socket
          hostPath:
            path: /var/run/docker.sock
            type: Socket
        - name: backup-data
          persistentVolumeClaim:
            claimName: backup-storage
        - name: db-data
          persistentVolumeClaim:
            claimName: backup-db
        - name: audit-logs
          persistentVolumeClaim:
            claimName: audit-logs
      
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchExpressions:
                    - key: app
                      operator: In
                      values:
                        - docker-backup
                topologyKey: kubernetes.io/hostname

---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: backup-storage
  namespace: docker-backup-enterprise
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 500Gi

---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: backup-db
  namespace: docker-backup-enterprise
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 100Gi

---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: audit-logs
  namespace: docker-backup-enterprise
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 50Gi

---
apiVersion: v1
kind: Service
metadata:
  name: backup-service
  namespace: docker-backup-enterprise
  labels:
    app: docker-backup
spec:
  type: ClusterIP
  selector:
    app: docker-backup
  ports:
    - name: http
      port: 80
      targetPort: 42880
      protocol: TCP
    - name: metrics
      port: 9090
      targetPort: 9090
      protocol: TCP

---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: backup-service
  namespace: docker-backup-enterprise
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: docker-backup

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ServiceAccount
metadata:
  name: backup-service
  namespace: docker-backup-enterprise

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: backup-service
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["persistentvolumeclaims"]
    verbs: ["get", "list"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: backup-service
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: backup-service
subjects:
  - kind: ServiceAccount
    name: backup-service
    namespace: docker-backup-enterprise
```

**Deploy:**

```bash
# 1. Create namespace & secrets
kubectl create namespace docker-backup-enterprise

# 2. Generate DB password
DB_PASSWORD=$(openssl rand -base64 32)
kubectl create secret generic backup-secrets \
  --from-literal=LICENSE_KEY=ENTERPRISE-SELF-HOSTED-XXXX \
  --from-literal=DB_PASSWORD=$DB_PASSWORD \
  -n docker-backup-enterprise

# 3. Apply manifests
kubectl apply -f enterprise-k8s.yaml

# 4. Verify deployment
kubectl get pods -n docker-backup-enterprise
kubectl logs -n docker-backup-enterprise -l app=docker-backup

# 5. Port forward for testing
kubectl port-forward -n docker-backup-enterprise svc/backup-service 42880:80
```

### Enterprise Managed (AWS)

**Architecture deployed automatically:**

```bash
# Via Terraform (provided by Docker)
terraform init
terraform apply \
  -var="customer_id=customer-123" \
  -var="license_key=ENTERPRISE-MANAGED-XXX" \
  -var="region=us-east-1" \
  -var="redundancy=high"

# Outputs:
# - S3 bucket (encrypted)
# - RDS PostgreSQL (HA)
# - ECS Fargate cluster (3x replicas)
# - VPC endpoints (private access)
# - CloudWatch monitoring
# - KMS keys (CMEK)
```

---

## Monitoring & Observability

### Prometheus Metrics

```yaml
# prometheus.yml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'docker-backup'
    static_configs:
      - targets: ['localhost:42880']
    metrics_path: '/metrics'

  - job_name: 'postgres'
    static_configs:
      - targets: ['backup-db:9187']
```

### Grafana Dashboards

Pre-built dashboards:
- Backup success rate (%)
- Backup duration (min/max/avg)
- Storage usage (GB)
- Network throughput (Mbps)
- Policy health status
- Retention cleanup metrics

---

## Upgrade Paths

```
Free → Pro:
  1. Set DRK_LICENSE_KEY in environment (or paste the key in Settings → About → license field)
  2. Restart service
  3. Data persists, no migration needed

Pro (Self) → Pro (Managed):
  1. Export backups via CLI
  2. Upload to Docker managed S3
  3. Recreate policies in managed infrastructure

Pro → Enterprise:
  1. Contact sales
  2. Enterprise TAM onboarding
  3. Migrate to Enterprise infrastructure
  4. Historical data transferred
```

Done! All deployment tiers ready to ship.
