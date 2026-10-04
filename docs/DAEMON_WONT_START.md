# Docker daemon will not start

A runbook for the case where Docker Desktop shows **"An unexpected error occurred"** and the engine
never comes up.

> **First thing to know: the error in the dialog is frequently not the cause.**
>
> When `dockerd` exits during startup, Docker Desktop reports whichever non-fatal message it logged
> most recently — not the fatal one. Confirmed on 4.84.0 and 4.87.0. The same underlying fault has
> been observed reported as `enable fsverity failed: operation not supported` on one version and
> `config.v2.json: no such file or directory` on another. Neither is the failure.

## Step 1 — get the real error

```
drk doctor
```

Runs on the host. Needs no daemon, no API key, and no running DRK — deliberately, because when the
daemon is down the DRK extension is down with it.

It reads Docker Desktop's VM init log directly and matches it against a catalogue of known-fatal
daemon errors. Exit code is `2` when something fatal is found, `0` otherwise, so it is usable in
scripts. Add `--json` for machine-readable output.

If DRK isn't installed, read the log yourself. It is the only place the real error appears:

| Platform | Path |
| --- | --- |
| Windows | `%LOCALAPPDATA%\Docker\log\vm\init.log` |
| macOS | `~/Library/Containers/com.docker.docker/Data/log/vm/init.log` |
| Linux | `~/.docker/desktop/log/vm/init.log` |

Search for `failed to start daemon:`. That line is the truth.

## Step 2 — act on the finding

### `DUPLICATE_BRIDGE_NETWORK`

A stale network owns the default bridge name, so `dockerd` cannot create the default bridge and
exits 1 on every start. The store does not self-heal, and Docker offers no in-product remedy short
of a factory reset.

```
drk doctor --repair-network-store
```

Requires Docker Desktop quit and `wsl --shutdown` already run — the command refuses if the
`docker-desktop` distro is still up, because the data disk cannot be safely mounted while Docker
holds it.

What it does: mounts the Docker data VHDX, locates `local-kv.db`, copies it to a timestamped
`.bak`, removes it, syncs, unmounts.

**Scope:** all user-defined networks are erased. Docker rebuilds `bridge`, `host` and `none` on next
start. Images, containers, volumes and build cache are untouched.

Then put the networks back:

```
drk backup:restore-networks <backupId>
```

This replays the network topology from the `control-plane.json` captured with that backup. It skips
predefined networks, networks that already exist, and any entry whose bridge name is already
claimed — replaying one of those would recreate the conflict you just repaired.

Run with `--dry-run` first to see what it would create.

### `ADDRESS_POOL_EXHAUSTED`

No non-overlapping private address space left for the default bridge, usually from a large number
of accumulated user-defined networks or a host route overlapping Docker's defaults. Remove unused
networks, or set explicit `default-address-pools` in `daemon.json`.

### `GRAPHDRIVER_INIT_FAILED`

The layer store was written by a different storage driver, or the backing filesystem changed. **Do
not clear the layer store** — that destroys every image. Capture a diagnostics bundle and establish
which driver wrote the existing data first.

### `DAEMON_PID_PRESENT`

A stale pid file from a hard-killed daemon. Confirm no `dockerd` is running, then remove it.

### `GENERIC_DAEMON_FAILURE`

Not in the catalogue yet. The message shown is the daemon's own fatal error and is more reliable
than the Docker Desktop dialog. Capture a diagnostics bundle before changing anything, and please
[open an issue](https://github.com/GoZippy/DockerRescueKit/issues) with the line — that is how the
catalogue grows.

## Things that don't work

Worth knowing so you don't lose time to them:

- **`docker network rm <id>`** needs a daemon. The daemon is what won't start.
- **`"bridge": "none"` in `~/.docker/daemon.json`** is silently discarded when Docker Desktop
  generates its effective config. No warning is emitted.
- **`wsl -d docker-desktop`** gives you the distro rootfs *without the data disk mounted*.
  `/var/lib/docker` will look empty. That doesn't mean you're in the wrong place — the disk simply
  isn't attached. Mount it explicitly with `wsl --mount --vhd`.
- **`wsl --update`** does not help with any of the above.

## Prevention

- **Keep control-plane snapshots.** Every DRK policy run captures `control-plane.json` automatically.
  A few KB, and it is the difference between a replay and a rebuild.
- **Avoid hard-killing `com.docker.backend`.** The network store is boltdb; a kill mid-write is a
  plausible route to exactly this corruption. Quit through the tray where you can.
- **Watch backend memory.** A runaway `com.docker.backend` (we have seen 23 GB RSS) is what makes
  people reach for a forced kill in the first place.
- **Keep the network count down.** Extensions and long-lived compose projects accumulate networks
  quietly; `drk networks` will show you how many you have.

## See also

- [`STARTUP_RESCUE.md`](STARTUP_RESCUE.md) — the PowerShell companion, for hosts without Node
- [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) — general DRK issues
