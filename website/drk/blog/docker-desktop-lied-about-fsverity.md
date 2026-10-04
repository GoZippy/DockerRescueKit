---
title: "Docker Desktop told me fs-verity was broken. It was lying, and it cost me two days."
description: "A Docker daemon that wouldn't start, an error message pointing at the wrong thing entirely, and the 512 KB file that was actually to blame."
date: 2026-08-21
tags: [docker, docker-desktop, wsl2, debugging, postmortem]
---

# Docker Desktop told me fs-verity was broken. It was lying, and it cost me two days.

On a Wednesday morning my Docker Desktop stopped working. It threw the dialog everyone who
uses Docker on Windows has seen at least once:

> **An unexpected error occurred**
> service command exited with code 1: command exited with code 1: enable fsverity failed: operation not supported
>
> *[Quit]  [Reset to factory defaults]*

Two buttons. Quit, or destroy every image, container and volume on the machine.

The error mentions fs-verity, a Linux kernel feature for file authenticity. So I spent a while
reading about fs-verity. Whether the WSL2 kernel had `CONFIG_FS_VERITY`. Whether ext4 needed the
`verity` feature flag on the superblock. Whether a recent Docker Desktop update had started
requiring it.

All of that was wasted. fs-verity had nothing to do with it.

## What the dialog doesn't tell you

Docker Desktop writes a log inside its Linux VM, at
`%LOCALAPPDATA%\Docker\log\vm\init.log`. It keeps writing it even when the daemon is dead. Here
is the relevant sequence from one failed start, trimmed:

```json
{"component":"command","error":"enable fsverity failed: operation not supported",
 "level":"warning","msg":"failed check for fsverity support",
 "path":"/var/lib/docker/plugins/storage","time":"2026-08-21T02:40:56.436Z"}

... daemon continues normally for seven more seconds ...

{"component":"command","error":"failed to start daemon: Error initializing network controller:
 error creating default \"bridge\" network: cannot create network d12fae8f… (docker0):
 conflicts with network d50e9b7d… (docker0): networks have same bridge name",
 "level":"info","msg":"Daemon shutdown complete","time":"2026-08-21T02:41:03.255Z"}

{"component":"control","level":"error",
 "msg":"{\"name\":\"command\",\"err\":\"command exited with code 1: enable fsverity failed:
 operation not supported\",\"exit_code\":1}","time":"2026-08-21T02:41:03.292Z"}
```

Read those three entries in order.

1. At `02:40:56` the daemon logs an fs-verity message. Note the level: **`warning`**. It's a
   capability probe against the plugin content store. The daemon shrugs and carries on.
2. At `02:41:03`, seven seconds later, the daemon hits the actual fatal error and exits. A stale
   network already owns the `docker0` bridge name, so the default bridge can't be created.
3. Immediately after, the control plane reports the process exit — and attaches **the fs-verity
   warning from step 1** as the reason.

That third line is the bug. The fatal error is right there, one entry above it, and it gets
dropped in favour of a harmless warning logged seven seconds earlier.

Notice something else about the fatal error: `"level":"info"`. The one entry that actually
explains why Docker won't start is logged at info level, while the irrelevant one is a warning.
That's very likely the whole mechanism — something is selecting the highest-severity recent entry,
and the real error doesn't qualify.

## It wasn't a one-off

Before the failure I was on Docker Desktop 4.84.0. Mid-debug it auto-updated itself to 4.87.0,
which sent me down another dead end for a while — the timing was suspicious enough that I was
confident the update had broken it.

It hadn't. Searching back through the rotated logs, the same bridge conflict first appeared at
11:24 that morning, **37 minutes before the update**. And 4.84.0 had reported it as:

```
service command exited with code 1: command exited with code 1:
open /var/lib/docker/containers/b696e235…/config.v2.json: no such file or directory
```

A completely different wrong error. Same underlying fault. That one is an `error`-level entry
logged during container restore, which the daemon also continues past.

So the bug isn't "Docker Desktop reports fs-verity". It's "Docker Desktop reports whatever
non-fatal thing it logged most recently." Two versions, two different decoys, and in both cases
the actual `failed to start daemon:` line never reached the user.

## The real fault

A single record in libnetwork's key-value store. Docker keeps network definitions in a boltdb
file at `/var/lib/docker/network/files/local-kv.db`. A stale network —
`d50e9b7dac76e9894ab5c1b1e505cb607a0e12ae362d46b281144f5a927a5cc3` — held the `docker0` bridge
name. On every start `dockerd` tried to create the default bridge, found the name taken, and
exited 1.

When I finally got the store listed, the timestamp settled it:

```
524288 bytes   Aug 19 11:24   .../network/files/local-kv.db
```

512 KB, last written at 11:24 on the 19th — the exact minute of the first failure — and untouched
through every start attempt across the following two days. The daemon never got far enough to
write to it again. Frozen at the moment of corruption.

That file is why the machine was down. Nothing else on the disk was damaged. Every image, every
container, every volume was intact the whole time.

## Why it was so hard to remove

The obvious fix doesn't work:

```
$ docker network rm d50e9b7dac76e9894ab5c1b1e505cb607a0e12ae362d46b281144f5a927a5cc3
Error response from daemon: Docker Desktop is unable to start
```

`docker network rm` needs a daemon. The daemon is what won't start. That's the shape of this
entire class of problem, and it's worth sitting with: **every tool you'd normally reach for runs
on top of the thing that's broken.**

Next attempt: tell the daemon to skip creating the default bridge at all, using the documented
option in `~/.docker/daemon.json`:

```json
{ "bridge": "none" }
```

Docker Desktop generates its own `/run/config/docker/daemon.json` and the key was silently
discarded. Same failure, no warning that the setting had been dropped.

Third attempt, and a trap worth flagging for anyone else who ends up here: `wsl -d docker-desktop`
gets you a shell in the distro, but **that is not where `/var/lib/docker` lives**. You get the
distro rootfs without the data disk mounted, so the path just looks empty and you conclude you're
in the wrong place. You aren't — the disk simply isn't attached.

## What actually worked

Attach the data disk yourself, with Docker fully stopped.

```powershell
Stop-Process -Name 'Docker Desktop','com.docker.backend' -Force -ErrorAction SilentlyContinue
wsl --shutdown
Start-Sleep 5

# Path comes from CustomWslDistroDir in settings-store.json,
# or %LOCALAPPDATA%\Docker\wsl\ on a default install.
wsl --mount --vhd "<data-dir>\disk\docker_data.vhdx" --name dockerdata --type ext4

# Confirm what you're about to delete, and check its mtime.
wsl -d <your-distro> -u root -- bash -c \
  "find /mnt/wsl/dockerdata -path '*/network/files/local-kv.db' -ls"

wsl -d <your-distro> -u root -- bash -c \
  "cd /mnt/wsl/dockerdata/data/docker/network/files && \
   cp -a local-kv.db local-kv.db.bak && rm -f local-kv.db && sync"

wsl --unmount "\\?\<data-dir>\disk\docker_data.vhdx"
wsl --shutdown
```

Docker came up on the next start. It rebuilt `bridge`, `host` and `none` automatically. Images,
containers, volumes and build cache were all untouched. The only casualty was user-defined
networks, which `docker compose up` recreates per project.

Two days, to delete one file.

## What we changed in Docker Rescue Kit

We build [Docker Rescue Kit](https://hub.docker.com/r/gozippy/dockerrescuekit), a backup and
restore extension for Docker. This incident was a useful humiliation, because DRK could not have
helped with any of it. Everything it knows about your Docker install, it learns by asking the
daemon. When the daemon is gone, DRK is blind — and worse, the extension itself doesn't run,
because extensions are containers.

Three changes, all shipping in the next release.

### 1. `drk doctor` — read the log, not the dialog

A host-side command that needs no daemon, no API key, and no running DRK:

```
$ drk doctor

drk doctor — offline Docker daemon diagnosis
log: C:\Users\you\AppData\Local\Docker\log\vm\init.log
last written: 2026-08-21T02:41:04.127Z (18442 lines scanned)

[CRITICAL] DUPLICATE_BRIDGE_NETWORK: A stale network already owns the default bridge name
  The daemon could not create the default "docker0" network because network d50e9b7d…
  already claims that bridge name. Every start attempt fails identically; the store does
  not self-heal.
  seen: 2026-08-21T02:41:03.255Z
  next: Clear libnetwork's key-value store with the engine stopped, then restore network
        definitions from the most recent snapshot.
  repairable by drk: yes — Erases user-defined networks. Images, containers and volumes
        are untouched; compose recreates its networks on the next up.

Docker Desktop may be showing one of these unrelated messages as the cause. Ignore them:
  - A warning-level fs-verity capability probe against /var/lib/docker/plugins/storage.
    The daemon continues normally after logging it. Not a cause of startup failure.
```

That last section matters as much as the diagnosis. If we only told you the real error, you'd
still be looking at a dialog saying something different and wondering which to believe.

The catalogue behind it has entries for specific repairable faults, but the workhorse is a generic
matcher for any `failed to start daemon: <reason>` line. Even for a failure nobody has catalogued,
you get the daemon's own words instead of Docker Desktop's guess.

Repair is opt-in and leaves a backup:

```
$ drk doctor --repair-network-store
```

It refuses to run while the `docker-desktop` distro is still up, refuses to run if no
`DUPLICATE_BRIDGE_NETWORK` finding is present unless you add `--force`, and writes a timestamped
`.bak` beside the file before removing it.

### 2. Control-plane snapshots

Here's the part that stung. I had backups. I'd been diligent. They were completely irrelevant,
because this wasn't data loss — it was a corrupted 512 KB control-plane record, and DRK backed up
the payload while ignoring the machinery.

Every policy run now also captures Docker's network topology and daemon identity to
`control-plane.json`. It costs a few kilobytes. Had I had Tuesday's copy, the repair would have
been non-lossy.

### 3. Non-lossy repair

Clearing the store erases every user-defined network. So:

```
$ drk backup:restore-networks <backupId>
```

replays them from the snapshot. With one important detail: the restore skips any network whose
bridge name is already claimed. A naive replay would have faithfully recreated the duplicate
`docker0` entry and put the daemon straight back where it started. If you build something like
this yourself, that's the bug to watch for.

## The general lesson

The thing I'd take away from this isn't about networks or fs-verity. It's that **an error message
you trust is worse than no error message at all.** With no message I'd have gone to the logs in
ten minutes. With a confident, specific, wrong message, I went and researched kernel filesystem
features for a day and a half.

If you write software that reports errors on behalf of a subsystem: report the one that killed it.
Not the loudest one. Not the most recent one. If you can't tell which is which, say so — "the
daemon exited 1; here are the last 20 log lines" would have been dramatically more useful than a
confident pointer at the wrong thing.

And if you build tooling that diagnoses a system: check whether your tool survives the failures it
claims to diagnose. Ours didn't. That's fixed now.

---

*Filed against Docker as a bug report covering the misattributed error, the missing repair path,
and the silently discarded `bridge` key. Docker Rescue Kit is source-available and free for
personal and educational use — [Docker Hub](https://hub.docker.com/r/gozippy/dockerrescuekit) ·
[GitHub](https://github.com/GoZippy/DockerRescueKit).*
