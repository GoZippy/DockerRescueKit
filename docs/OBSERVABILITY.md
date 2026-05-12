# Observability

DockerRescueKit exposes a Prometheus-format `/metrics` endpoint so you
can wire it into the monitoring stack you already run. This document
covers what the metrics mean, how to scrape them, and the example
alerting rules shipped alongside.

## The `/metrics` endpoint

- **Path:** `GET /metrics`
- **Auth:** none. Deliberately unauthenticated so Prometheus / Uptime
  Kuma / Telegraf can scrape without an API key. The endpoint exposes
  counts and ages — no secrets, no backup contents.
- **Format:** Prometheus text exposition format. Pin a CIDR ACL at your
  reverse proxy (see `docs/REVERSE_PROXY.md`) if the host is reachable
  from outside your LAN.

## Counters and gauges

Names are stable across the v1.x line. The full source of truth is
`packages/backend/src/services/MetricsService.ts`.

| Metric                                  | Type    | Description |
|-----------------------------------------|---------|-------------|
| `drk_policies_total`                    | gauge   | Number of backup policies configured. |
| `drk_policies_enabled`                  | gauge   | Number of *enabled* policies. |
| `drk_backup_success_total`              | counter | Successful backups, labelled `policy_id` + `policy_name`. |
| `drk_backup_failed_total`               | counter | Failed backups, same labels. |
| `drk_backup_last_success_age_seconds`   | gauge   | Seconds since last successful backup per policy. |
| `drk_backup_last_size_bytes`            | gauge   | Bytes in the most recent successful backup per policy. |
| `drk_backup_last_duration_seconds`      | gauge   | Wall-clock duration of the most recent successful backup. |
| `drk_verify_passed_total`               | counter | Successful integrity-verify runs (global, not per-policy). |
| `drk_verify_failed_total`               | counter | Failed integrity-verify runs. |
| `drk_verify_last_pass_age_seconds`      | gauge   | Seconds since the last passing verify run. |

The `drk_backup_*` family is the primary signal for "is my data
actually being backed up?". The `drk_verify_*` family is the canary
for "are the bytes I backed up actually restorable?". Alert on both.

## Scraping

Add a job to `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: dockerrescuekit
    metrics_path: /metrics
    scrape_interval: 30s
    static_configs:
      - targets: ['drk:42880']   # or your reverse-proxied hostname
        labels:
          environment: homelab
```

If you scrape via the reverse proxy on HTTPS, set `scheme: https` and
`scrape_timeout: 10s` to absorb TLS handshake jitter.

## Example alerts

`docs/prometheus-alerts.yml.example` ships four rules covering the
failure modes that actually bite homelabbers:

- **`BackupOlderThan48h`** (critical) — policy has gone two days
  without a successful backup.
- **`BackupFailuresIncreasing`** (warning) — any failure in the last
  hour.
- **`VerifyFailuresDetected`** (warning) — integrity verify failed in
  the last 24h. Strong indicator the *next* restore will fail.
- **`BackupSizeShrunk`** (warning) — latest backup is <50% of the
  same metric a week ago. Catches silent data loss when a volume gets
  unselected or a container is removed.

To load them, copy the file into Prometheus's rules directory and
reference it from `prometheus.yml`:

```yaml
rule_files:
  - "rules/drk.rules.yml"
```

Then reload Prometheus (`curl -X POST http://prometheus:9090/-/reload`).

## Quick Grafana wiring

There's no shipped dashboard JSON — the metric set is small enough
that hand-rolling a 4-panel dashboard (success age, success/failure
rate, last size trend, verify age) takes about five minutes. PRs
welcome if you build one worth sharing.
