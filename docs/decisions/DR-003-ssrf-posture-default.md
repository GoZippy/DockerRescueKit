# DR-003 — SSRF guard default posture

**Status**: Proposed (paired with F1 consensus vote — unanimous required)
**Date**: 2026-05-29
**Author**: claude-code (WA-1), with design correction during implementation
**Sprint**: v1.3-connectors / Sprint 1 / Task F1
**Blocks**: F1-ssrf-allowlist (Sprint 2 cannot start until F1 + this DR pass consensus)

## Context

When implementing F1 (`SsrfGuard.ts`), the initial design used a strict-by-default deny list (loopback + RFC1918 + link-local + IPv6 ULA), reasoning from generic SSRF best practice. That posture is wrong for DRK's actual audience:

- DRK is **homelab-first**. The primary use cases are Proxmox at `10.0.0.0/8`, TrueNAS at `192.168.x.x`, SMB shares on `10.0.x.x`, SFTP backups at `192.168.x.x`. These are **always RFC1918**.
- A strict default would block every homelab user out of the box, requiring `DRK_SSRF_ALLOWLIST=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16` on first install or Test Connection would silently fail.
- The genuine SSRF threat for DRK is **cloud instance-metadata exfiltration** (`169.254.169.254`, `fd00:ec2::254` for AWS IMDSv6). That's the high-value asymmetric attack — an authenticated user can read AWS credentials from a hosted DRK install. Everything else is just "you can reach your own LAN."

## Decision

**Two postures, picked by env var:**

### Default (homelab-first, no env var set)

Deny list:
- `169.254.169.254/32` — AWS/GCP/Azure IMDS
- `fd00:ec2::254/128` — AWS IMDSv6

Allowed:
- Loopback (`127.0.0.0/8`, `::1`)
- RFC1918 (`10/8`, `172.16/12`, `192.168/16`)
- Link-local except metadata (`169.254.0.0/16` minus the IMDS IP)
- IPv6 ULA (`fc00::/7`)
- Public internet

Rationale: homelab user can target their LAN day one; metadata theft still blocked.

### Strict (`DRK_SSRF_STRICT=1`)

Deny list:
- All loopback, link-local (including metadata), RFC1918, IPv6 ULA

Intended for:
- Hosted/multi-tenant DRK deployments (we don't ship one yet, but the posture should exist for when we do or third parties package one)
- Single-tenant installs that explicitly want zero internal reach
- Compliance environments

### Allowlist override (both postures)

`DRK_SSRF_ALLOWLIST=10.0.0.0/8,192.168.0.0/16` (csv of CIDRs) escapes the active deny list. Used in strict mode to punch holes for known-safe LAN ranges, or in default mode to *re-allow* the metadata IP if someone genuinely needs to reach it (e.g. a Proxmox host that happens to be at `169.254.x.x`, vanishingly rare).

## Alternatives considered

### A) Strict default + document `DRK_SSRF_ALLOWLIST` prominently
- **Pro**: matches generic SSRF best practice; sets a high bar.
- **Con**: every homelab user's first Test Connection fails. UX disaster. Bug reports incoming. Many users will set `DRK_SSRF_ALLOWLIST=0.0.0.0/0` to get out of the way — defeating the purpose.
- **Verdict**: rejected. The wrong posture for DRK's audience.

### B) No SSRF guard at all
- **Pro**: zero friction.
- **Con**: trivially exploitable in any hosted scenario; F1's whole point is closing this hole.
- **Verdict**: rejected.

### C) Strict default + auto-detect homelab via private IP on host interfaces
- **Pro**: best of both worlds in theory.
- **Con**: brittle — Docker network interfaces look like RFC1918 even on cloud hosts. False positives in both directions. Complexity not worth it.
- **Verdict**: rejected.

## Consequences

**Positive**
- Homelab user: zero-config, day-one functional. Proxmox/TrueNAS/SMB just work.
- Cloud-hosted user: still protected from the dangerous case (metadata theft).
- Compliance user: one env var (`DRK_SSRF_STRICT=1`) and they're locked down.

**Negative**
- Default posture allows reaching arbitrary LAN hosts. An authenticated attacker with API access can scan the local network. Mitigated by:
  - DRK's API requires `x-api-key` auth (auth bypass would be a worse bug).
  - If we ever ship a hosted multi-tenant DRK, the deploy config sets `DRK_SSRF_STRICT=1` — it would not be safe to ship without.

**Documentation requirement**
- DOC1 (Sprint 3, `docs/CONNECTORS.md`) must explain both postures and the allowlist.
- `docs/SECURITY.md` (does not exist yet — maybe DOC1 spawns it) should note the posture choice and the threat model.

## Implementation

See [packages/backend/src/security/SsrfGuard.ts](../../packages/backend/src/security/SsrfGuard.ts):

```ts
static isStrict(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.DRK_SSRF_STRICT?.trim() ?? '')
}

static defaultDeny(): string[] {
  return this.isStrict() ? STRICT_DENY : CLOUD_METADATA_CIDRS
}
```

Tests covering both postures + allowlist override + DNS path are in [packages/backend/src/__tests__/security/ssrfGuard.test.ts](../../packages/backend/src/__tests__/security/ssrfGuard.test.ts) — 51 cases passing.

## Votes (consensus gate)

Threshold: **unanimous** (security change per `.claude/rules/cross-agent-protocol.md`).

- [x] claude-code: APPROVE (proposing)
- [ ] kilocode: pending
- [ ] antigravity: pending

Votes land in `.autoclaw/orchestrator/comms/consensus/active/F1-ssrf-allowlist-{agent}.json` — this DR is paired with F1 (same code, same vote).

## References

- [F1 implementation — SsrfGuard.ts](../../packages/backend/src/security/SsrfGuard.ts)
- [F1 tests — ssrfGuard.test.ts](../../packages/backend/src/__tests__/security/ssrfGuard.test.ts)
- [DR-001](DR-001-connector-discovery-semantic.md) — sibling Sprint 1 decision
- [v1.3-connectors manifest](../../.autoclaw/orchestrator/manifests/v1.3-connectors.yaml)
- AWS IMDSv2 docs (why metadata is the high-value SSRF target): https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-service.html
