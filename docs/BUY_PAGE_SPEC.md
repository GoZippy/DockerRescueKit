# DRK Purchase Page — Build Spec

**Status:** REQUIRED — not yet built. This is the single missing link in the upgrade flow.

## Why this exists

The DRK extension and backend already point paying customers at purchase URLs, but
those pages do not exist (verified 2026-06-15):

| URL (referenced in code) | Live status |
|---|---|
| `https://gozippy.com/drk` | needs to be created (extension `UPGRADE_URL`) |
| `https://gozippy.com/drk/personal-pro` (`licenseGate.ts:20`) | **does not resolve** |
| `https://gozippy.com/drk/commercial-pro` (`licenseGate.ts:21`) | **404** |
| `https://license.gozippy.com/thank-you` | **200 (live)** — post-checkout landing |

The back half of the funnel is fully operational: Square webhook → HMAC verify →
RS256 JWT mint → email → in-app activation (now wired in Settings → About). The only
gap is a page where a customer can actually click "Buy."

`gozippy.com` is cPanel-hosted (not Cloudflare) — so this is a static page or simple
PHP/HTML on the existing host, not a new service.

## Pages to create

Create three routes (or one pricing page with anchor sections + three buy buttons):

- `gozippy.com/drk` — pricing overview, all tiers, the canonical landing.
- `gozippy.com/drk/personal-pro` — Personal Pro detail + buy button.
- `gozippy.com/drk/commercial-pro` — Commercial Pro detail + buy button.

Each "Buy" button is a link to a **Square Payment Link** (hosted checkout). No
server code needed on gozippy.com — Square hosts the checkout and POSTs the
webhook to `license.gozippy.com/webhooks/square`.

## Square Payment Links — must match the live SKU map

The license server maps Square SKUs → tiers in `DRK_LicenseServer/src/skuMap.ts`.
The Payment Link line items **must use these exact SKUs** or the webhook will not
mint a license:

| Tier shown on page | Price (LICENSE Schedule A) | Square line-item SKU | Term |
|---|---|---|---|
| Personal Pro | **$29 one-time** | `DRK-PERSONAL-PRO-V1` | perpetual within major version |
| Commercial Pro (launch) | **$99/seat/year** | `DRK-COMMERCIAL-PRO-LAUNCH` | 365 days, price locked for life |
| Commercial Pro (standard) | **$149/seat/year** | `DRK-COMMERCIAL-PRO-STANDARD` | 365 days |
| Priority Queue add-on | **$750/year** | `DRK-PRIORITY-QUEUE` | 365 days |

- Commercial Pro is **per-seat** — enable quantity selection on the Square link
  (the webhook reads quantity → seats).
- Enterprise ($5,000+/yr) is **sales-only** — do NOT add a self-serve button; link
  to `Support@GoZippy.com`. (The license server currently cannot auto-mint
  `enterprise`; see "Known gap" below.)

## Post-checkout redirect

In each Square Payment Link's settings, set the redirect URL to:

```
https://license.gozippy.com/thank-you
```

That page (already live) echoes the order id + email and gives activation steps:
the customer receives the token by email, then pastes it into the extension at
**Settings → About → "Have a license key?"** (now implemented) or sets
`DRK_LICENSE_KEY`.

## Pricing must stay consistent

The binding source of truth is **LICENSE Schedule A**. Keep the page in sync with
it and with these (now-corrected) docs: README License section, `docs/ROADMAP.md`
final table, `docs/MARKETPLACE_LISTING_DRAFT.md`. Do **not** reintroduce the retired
"$89/year" figure or any "SLA / guaranteed response time" language (LICENSE §5.7
forbids SLA claims).

## Acceptance checklist

- [ ] `gozippy.com/drk`, `/drk/personal-pro`, `/drk/commercial-pro` all return 200.
- [ ] Each buy button opens a Square checkout with the correct SKU + price.
- [ ] Commercial Pro link allows seat-quantity selection.
- [ ] Square redirect lands on `license.gozippy.com/thank-you`.
- [ ] A test purchase (Square sandbox) fires the webhook and an email with a token arrives.
- [ ] Pasting that token in Settings → About flips the tier pill to **Pro** and unlocks Notifications.

## Known gap to resolve separately

The license server cannot currently issue the **Enterprise** tier: there is no
`SKU_ENTERPRISE`, and `DRK_LicenseServer/src/db/database.ts` `LicenseTier` omits
`enterprise`. Until that's added, Enterprise is manual/sales-only — keep it off the
self-serve page.
