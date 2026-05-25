# DRK Side-Cars

This directory holds **stack-specific backup side-car images** that
bundle the smallest possible backup loop for one popular application.
They are deliberately *standalone* — they do **not** require a running
DockerRescueKit backend. Drop one next to your app in
`docker-compose.yml`, set a few env vars, and walk away.

The pattern follows [`itzg/mc-backup`](https://hub.docker.com/r/itzg/mc-backup)
(10M+ pulls) — a one-purpose container that knows exactly one stack and
ships ready-to-run with sane defaults. Full DRK is for the homelabber
who wants a UI, policy management, multi-stack coverage, and restore
rehearsal. The side-cars are for the operator who just wants the
backup running by lunch.

## What's here today

| Side-car | Image | Stack | Status |
|---|---|---|---|
| [plex/](plex/) | `gozippy/drk-plex` | Plex Media Server | Prototype (v1.2-rc) |

## What's coming (V-1 series in the v1.2 sprint plan)

| Side-car | Image | Stack | Priority |
|---|---|---|---|
| `homeassistant/` | `gozippy/drk-ha` | Home Assistant | Next |
| `immich/` | `gozippy/drk-immich` | Immich (incl. Postgres) | Next |
| `nextcloud/` | `gozippy/drk-nextcloud` | Nextcloud + MariaDB | Future |
| `vaultwarden/` | `gozippy/drk-vw` | Vaultwarden | Future |

If you have a stack you'd like a side-car for, file an issue at
https://github.com/gozippy/DockerRescueKit/issues with the label
`sidecar-request`.

## Licensing & customization

The contents of `sidecars/` are classified as **Open Material** under
the [LICENSE](../LICENSE) (see [COMPONENTS.md](../COMPONENTS.md)). You
may fork, adapt, and rebuild these side-cars for your own use.

The published `gozippy/drk-*` images bundle:
- The `restic` and `rclone` binaries (their own upstream licenses;
  see `THIRD_PARTY_LICENSES.md` in the published image)
- A short shell entrypoint written specifically for this repo
- No DRK proprietary code — the `drk` CLI is **not** included; these
  side-cars are intentionally standalone

## Why standalone (not "uses DRK backend")

Two reasons:

1. **Install velocity.** `docker run -d gozippy/drk-plex …` should
   work without first deploying the DRK backend. The DRK backend is
   the *right* answer for multi-stack homelabs; for a single
   production Plex install, requiring an additional control-plane
   container is friction.
2. **No moving parts.** Restic + rclone + a 100-line shell loop
   surface a much smaller attack/failure surface than the full Node
   backend. Side-cars are for people who'd rather audit 100 lines
   than 18 service classes.

If you do run the DRK backend alongside these side-cars, the side-car
logs are structured (JSON) so DRK's audit-log scraper can pick them
up in a future release.
