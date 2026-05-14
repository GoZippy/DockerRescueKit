# Reverse Proxy & TLS

DockerRescueKit listens on plain HTTP (`:42880`) by default. For anything
beyond a single trusted LAN you should terminate TLS at a reverse proxy.
This document gives working copy-paste configurations for the three
proxies most homelab and small-business users actually run: **Caddy**,
**nginx**, and **Traefik**.

## Why a reverse proxy?

- **TLS termination.** Let the proxy own ACME / Let's Encrypt so DRK
  stays focused on backups. Rotating certs and HTTP/2 are free.
- **Request-size limits.** DRK's API accepts manifests, restore plans,
  and (potentially) streamed uploads. Put a cap at the edge so a
  runaway client can't fill your disk.
- **CIDR-based ACLs.** The dashboard and API key are sensitive. Pin
  the proxy to your LAN/VPN ranges so only trusted clients reach DRK
  even if the API key leaks.

All examples assume:

- DRK is running on a Docker host as service name `drk` on port `42880`.
- The public hostname is `drk.example.com`.
- Replace the hostname, ACME email, and CIDR allowlists with your own.

---

## Caddy

Caddy is the easiest option: one config file, auto-TLS via Let's Encrypt
by default, and the smallest blast radius for misconfiguration.

### `Caddyfile`

```caddy
{
    # Global options
    email admin@example.com
    # Uncomment to test against the staging CA before going live:
    # acme_ca https://acme-staging-v02.api.letsencrypt.org/directory
}

drk.example.com {
    # Optional: restrict to LAN + VPN. Remove if you want public access.
    @lan {
        remote_ip 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10
    }
    handle @lan {
        reverse_proxy drk:42880 {
            header_up X-Forwarded-For   {remote_host}
            header_up X-Forwarded-Proto {scheme}
            header_up X-Forwarded-Host  {host}
            header_up X-Real-IP         {remote_host}

            # DRK's healthcheck is cheap; let Caddy probe it.
            health_uri      /healthz
            health_interval 30s
            health_timeout  5s
        }
    }
    handle {
        respond "Forbidden" 403
    }

    # Caps an attacker can't blow past. Adjust for your largest manifest.
    request_body {
        max_size 50MB
    }

    # Standard hardening.
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options    "nosniff"
        Referrer-Policy           "no-referrer"
        -Server
    }

    encode zstd gzip
    log {
        output file /var/log/caddy/drk.log {
            roll_size 10mb
            roll_keep 5
        }
    }
}
```

If you're running Caddy on the host (not in a container) point the
`reverse_proxy` line at `http://localhost:42880` instead of `drk:42880`.

### `docker-compose.yml` snippet (Caddy as a sibling service)

```yaml
services:
  drk:
    image: gozippy/dockerrescuekit:standalone-latest
    container_name: drk
    restart: unless-stopped
    # Note: no `ports:` — only Caddy is exposed publicly.
    expose:
      - "42880"
    group_add:
      - "${DOCKER_GID:-999}"
    volumes:
      - drk-data:/data
      - drk-backups:/backups
      - /var/run/docker.sock:/var/run/docker.sock
    networks:
      - drk-net

  caddy:
    image: caddy:2
    container_name: caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"   # HTTP/3
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    networks:
      - drk-net
    depends_on:
      - drk

volumes:
  drk-data:
  drk-backups:
  caddy-data:
  caddy-config:

networks:
  drk-net:
    driver: bridge
```

---

## nginx

If you already run nginx as your edge proxy, drop this server block in
`/etc/nginx/conf.d/drk.conf` and reload (`nginx -s reload`). TLS certs
are managed externally (certbot, acme.sh, or your own CA).

```nginx
# /etc/nginx/conf.d/drk.conf
upstream drk_backend {
    server 127.0.0.1:42880;   # or: server drk:42880; if nginx is in the compose net
    keepalive 16;
}

server {
    listen 80;
    listen [::]:80;
    server_name drk.example.com;
    # Force HTTPS.
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name drk.example.com;

    ssl_certificate     /etc/letsencrypt/live/drk.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/drk.example.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
    ssl_session_cache   shared:SSL:10m;

    # CIDR-based ACL (LAN + tailscale CGNAT). Uncomment to enforce.
    # allow 10.0.0.0/8;
    # allow 172.16.0.0/12;
    # allow 192.168.0.0/16;
    # allow 100.64.0.0/10;
    # deny  all;

    # Cap upload size at the edge.
    client_max_body_size 50m;

    # Hardening
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options    "nosniff" always;
    add_header Referrer-Policy           "no-referrer" always;

    location / {
        proxy_pass http://drk_backend;

        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;
        proxy_set_header X-Forwarded-Port  $server_port;

        # Websocket / SSE upgrade headers — DRK doesn't ship WS today,
        # but if you enable SSE for live logs you'll want these.
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Long-running streams (verify, restore progress) need generous timeouts.
        proxy_read_timeout  600s;
        proxy_send_timeout  600s;
        proxy_buffering     off;
    }

    # Don't gate the unauthenticated liveness probe behind the ACL.
    location = /healthz {
        proxy_pass http://drk_backend;
        access_log off;
    }
}
```

---

## Traefik

Traefik watches the docker socket and reads labels off your services.
Add the labels below to the `drk` service and Traefik picks it up
automatically. This assumes Traefik is already configured with an ACME
resolver named `le` and an entrypoint named `websecure` on port 443.

```yaml
services:
  drk:
    image: gozippy/dockerrescuekit:standalone-latest
    container_name: drk
    restart: unless-stopped
    expose:
      - "42880"
    group_add:
      - "${DOCKER_GID:-999}"
    volumes:
      - drk-data:/data
      - drk-backups:/backups
      - /var/run/docker.sock:/var/run/docker.sock
    networks:
      - traefik
    labels:
      - "traefik.enable=true"
      - "traefik.docker.network=traefik"

      # Router
      - "traefik.http.routers.drk.rule=Host(`drk.example.com`)"
      - "traefik.http.routers.drk.entrypoints=websecure"
      - "traefik.http.routers.drk.tls=true"
      - "traefik.http.routers.drk.tls.certresolver=le"
      - "traefik.http.routers.drk.middlewares=drk-headers,drk-ratelimit,drk-ipallow"

      # Service
      - "traefik.http.services.drk.loadbalancer.server.port=42880"
      - "traefik.http.services.drk.loadbalancer.healthcheck.path=/healthz"
      - "traefik.http.services.drk.loadbalancer.healthcheck.interval=30s"

      # Middleware: forwarded headers + HSTS + nosniff
      - "traefik.http.middlewares.drk-headers.headers.stsSeconds=31536000"
      - "traefik.http.middlewares.drk-headers.headers.stsIncludeSubdomains=true"
      - "traefik.http.middlewares.drk-headers.headers.contentTypeNosniff=true"
      - "traefik.http.middlewares.drk-headers.headers.referrerPolicy=no-referrer"
      - "traefik.http.middlewares.drk-headers.headers.customRequestHeaders.X-Forwarded-Proto=https"

      # Middleware: rate limit (avoid brute force on /api/*)
      - "traefik.http.middlewares.drk-ratelimit.ratelimit.average=60"
      - "traefik.http.middlewares.drk-ratelimit.ratelimit.burst=120"

      # Middleware: CIDR allowlist — LAN + Tailscale CGNAT
      - "traefik.http.middlewares.drk-ipallow.ipallowlist.sourcerange=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10"

networks:
  traefik:
    external: true

volumes:
  drk-data:
  drk-backups:
```

---

## Verification checklist

After standing up the proxy:

1. `curl -I https://drk.example.com/healthz` → `200 OK`, no auth required.
2. `curl -H "x-api-key: $KEY" https://drk.example.com/api/status` → 200.
3. From an out-of-allowlist IP (e.g. mobile data, with `WIFI off`):
   `curl -I https://drk.example.com/healthz` → 403 (if ACL configured).
4. Check the backend sees the real client IP in its logs:
   `docker logs drk | grep X-Forwarded-For` — should show your client
   IP, not the proxy's container IP.

If the backend logs show the proxy IP instead of the real client,
the `X-Forwarded-For` chain is broken. Re-check the proxy config and
that `trust proxy` is enabled in DRK (already set when running behind
Caddy/nginx/Traefik on the same host).
