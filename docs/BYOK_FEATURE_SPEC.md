# BYOK / Customer-Managed Encryption Keys — Feature Spec

**Status:** PLANNED. This turns the `byok_encryption` entitlement from a hollow flag
into a real, enforceable Pro feature. Additive — baseline encryption stays free.

## Current state (v1.4.1)

- **Baseline encryption is universal.** Every tier encrypts stored credentials with
  AES-256-GCM. The key is loaded by `SecretsService.load()`
  ([SecretsService.ts](../packages/backend/src/services/SecretsService.ts)) in this
  precedence: existing `secrets.json` → `DRK_ENCRYPTION_KEY` / `ENCRYPTION_KEY` env
  → auto-generated 32-byte random. `EncryptionUtility.init()` derives the AES key via
  scrypt + a per-install salt.
- The only "bring your own key" path today is the **env var**, which is a
  deployment/ops escape hatch, not a product feature. It is unenforced and has no UI.
- `byok_encryption` is declared in `FEATURES_BY_TIER` for personal-pro / commercial-pro
  / enterprise but **gated nowhere**. Schedule A now states (corrected 2026-06-15) that
  baseline encryption is included in all tiers and the Pro entitlement is specifically
  *supplying + rotating your own key*.

## What this feature adds (the sellable part)

A Pro-gated capability to **manage your own encryption key from inside the app**:

1. **Set a customer-managed key** — paste/generate a key, or point at an external
   source (env, file path, or a KMS reference in a later phase).
2. **Rotate the key** — re-encrypt all existing vault entries under the new key, with
   a verified, atomic, rollback-safe migration.
3. **Visibility** — Settings shows whether encryption is using an auto-generated key
   or a customer-managed key, and when it was last rotated.

## Hard data-safety requirements (non-negotiable)

DRK is a backup tool; orphaning a user's encrypted vault is the cardinal sin
(see `feedback_data_safety_first`). Therefore:

- **Never gate `EncryptionUtility` / `VaultService` decryption on the license.** A
  downgrade, expiry, or offline-grace lapse must NEVER make existing data unreadable.
- **Rotation re-encrypts, then swaps.** Decrypt-all → re-encrypt-all under the new key
  → verify a round-trip → only then persist the new key and salt. On any failure, keep
  the old key. Take a `secrets.json` + vault backup first (reuse ExportService).
- **Existing `secrets.json` is always honored**, regardless of tier. Enforcement
  applies only to the *act of configuring/rotating* a customer-managed key, not to
  reading data already encrypted.

## Enforcement points (data-safe)

- The new **key-management endpoint(s)** are gated with
  `requireFeature(license, 'byok_encryption')` ([licenseGate.ts](../packages/backend/src/middleware/licenseGate.ts)) —
  same pattern as `notifications`. A free user gets `402` when trying to *set/rotate* a
  custom key; their existing encryption keeps working untouched.
- Boot-time `DRK_ENCRYPTION_KEY` (the ops escape hatch) stays open for self-hosters but
  is surfaced in `GET /api/status` `securityWarnings` as "customer-managed key active
  without a Pro entitlement" when no `byok_encryption` license is present — informational,
  never destructive. (Optional; decide before build.)

## Suggested implementation slices

1. **Provenance + visibility (safe, small):** `SecretsService` tracks `keySource:
   'generated' | 'env' | 'managed'`; expose it on the license/status DTO; Settings → About
   shows "Encryption: auto-generated key / customer-managed key". No gating, no data risk.
2. **Set/rotate API (the feature):** `POST /api/encryption/key` + `POST /api/encryption/rotate`,
   both `requireFeature('byok_encryption')`, with the re-encrypt-verify-swap migration above.
3. **UI:** Settings → Security card to set/rotate, Pro-locked with an Upgrade CTA (reuse
   the new `UPGRADE_URL` + license-entry flow shipped 2026-06-15).
4. **KMS reference (Enterprise, later):** AWS KMS / GCP KMS / Vault transit as the key source.

## Acceptance

- [ ] Free user cannot set/rotate a custom key via the app (402); their data stays readable.
- [ ] Pro user can set + rotate; rotation re-encrypts all vault entries and verifies.
- [ ] Killing the process mid-rotation leaves data readable under the old key (no partial state).
- [ ] License downgrade/expiry never breaks decryption of existing data.
- [ ] Schedule A, README, and `FEATURES_BY_TIER` stay consistent (baseline = all tiers; BYOK = Pro+).
