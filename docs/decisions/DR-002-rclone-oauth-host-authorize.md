# DR-002 — rclone OAuth runs on the user's host, not in the container

**Status**: Accepted (project owner chose host-side authorize, 2026-05-29)
**Date**: 2026-05-29
**Author**: claude-code
**Supersedes**: the in-container `rclone authorize` flow shipped through v1.2.x

## Context

The Integrations → "Add Remote" wizard offered browser-OAuth providers
(Google Drive, OneDrive, Dropbox). The implementation ran
`rclone authorize --auth-no-open-browser <type>` **inside the DRK
container**, scraped a URL from rclone's output, and told the user to open
it in their browser.

It could never work:

1. **The callback is unreachable.** `rclone authorize` starts an OAuth
   callback server on a fixed `127.0.0.1:53682`, and the provider only ever
   redirects back to that loopback address. Inside the container, `127.0.0.1`
   is a separate network namespace and port `53682` is never published
   (`docker-compose.yml` exposes only `42880`; in Docker Desktop *extension*
   mode nothing can be published at all). The user's host browser hitting
   `http://127.0.0.1:53682/` reaches the host loopback, where nothing listens
   → connection refused.

2. **The wrong line was scraped anyway.** The stderr parser grabbed the first
   `https?://…` rclone logged, which is the *"set your Redirect URL to
   `"http://127.0.0.1:53682/"`"* notice — including a stray trailing quote.
   That is the `http://127.0.0.1:53682/"` string users saw.

This is not a parsing bug to patch; the loopback-callback model is
fundamentally incompatible with running rclone in an isolated container.

## Decision

Adopt rclone's documented **remote / headless setup** pattern: the
`rclone authorize` step runs **on a machine that has a browser** (the user's
own desktop), and the token it prints is pasted back into DRK.

- `RcloneService.buildAuthorizeCommand(type)` returns the command to run on
  the host — `rclone authorize "drive"` — instead of spawning anything.
- `POST /api/rclone/oauth/start` returns `{ command }` (was `{ url }`).
- `RcloneService.finishOAuth(remoteName, type, token)` writes the pasted token
  into the **container's** rclone config via `rclone config create … token=…`.
  The container's rclone is still used for everything else (create, `lsd`
  test, `listremotes`) — only the *browser* step moves to the host.
- The token auto-poll and `oauth/cancel` endpoints are removed: with rclone
  running on the host there is no in-container process to poll or kill. The
  user always pastes the token.

### Considered and rejected

- **Publish 53682 + bind `0.0.0.0`.** Needs a compose change + redeploy, has
  no documented bind-address override for `rclone authorize`, and is
  impossible in Docker Desktop extension mode. Rejected.
- **Hosted OAuth relay** (DRK ships its own client IDs + a public callback).
  Smoothest UX but a real feature with security-review surface (client
  secrets, per-deployment redirect URIs). Deferred to roadmap.

## Consequences

- **+** Works identically in standalone and Docker Desktop extension modes;
  no networking assumptions.
- **+** No secret material or moving OAuth machinery in the container beyond
  the final token.
- **−** The user needs rclone installed on the machine where they run the
  authorize command (we already detect/instruct rclone install). The wizard
  states this requirement up front.
- **Known limitation:** OneDrive's `drive_id`/`drive_type` are not captured by
  a bare `rclone authorize "onedrive"`; the personal drive default is used.
  Multi-drive selection is a follow-up (no regression — the old flow never set
  it either).
