# DRK Purchase Pages (`gozippy.com/drk`)

Static HTML + CSS for the DockerRescueKit purchase / pricing funnel. No framework,
no build step, no JS dependencies. Drop these files straight into cPanel.

## Files

```
drk/
  index.html              -> gozippy.com/drk            (pricing overview, all tiers)
  personal-pro/index.html -> gozippy.com/drk/personal-pro
  commercial-pro/index.html -> gozippy.com/drk/commercial-pro
  styles.css              shared stylesheet (linked by all three pages)
  README.md               this file (do not upload)
```

## Where to upload (cPanel)

Upload the contents of this `drk/` folder into `public_html/drk/` on the
gozippy.com cPanel account, preserving the subfolder structure:

```
public_html/
  drk/
    index.html
    styles.css
    personal-pro/index.html
    commercial-pro/index.html
```

The folder-with-`index.html` layout gives you clean URLs (`/drk`,
`/drk/personal-pro`, `/drk/commercial-pro`) without needing rewrite rules.
Do **not** upload `README.md` to the live host (optional — it just isn't needed).

Acceptance: `/drk`, `/drk/personal-pro`, and `/drk/commercial-pro` must all return 200.

## REQUIRED: replace the Square Payment Link placeholders

Every buy button currently points at a placeholder `href`. Before going live,
create the Square Payment Links and replace each placeholder with the real
hosted-checkout URL. An HTML comment next to each button records the exact
Square line-item SKU it must use — these SKUs MUST match
`DRK_LicenseServer/src/skuMap.ts` or the webhook will not mint a license.

| Placeholder `href` | Square line-item SKU | Price / term |
|---|---|---|
| `https://square.link/u/bPvzu5Ik` | `DRK-PERSONAL-PRO-V1` | $29 one-time, perpetual within major version |
| `https://square.link/u/9it5UmKX` | `DRK-COMMERCIAL-PRO-LAUNCH` | $99/seat/year launch (locked for life); standard SKU `DRK-COMMERCIAL-PRO-STANDARD` = $149/seat/year |
| `https://square.link/u/5hPPzp8r` | `DRK-PRIORITY-QUEUE` | $750/year |

Placeholders appear in:
- `index.html` (all three: Personal Pro, Commercial Pro, Priority Queue)
- `personal-pro/index.html` (Personal Pro)
- `commercial-pro/index.html` (Commercial Pro)

### Commercial Pro: enable seat-quantity selection

Commercial Pro is **per-seat**. On the Square Payment Link, enable quantity
selection — the webhook reads the purchased quantity as the seat count. Enforce
the **3-seat minimum** (e.g. set the minimum quantity on the Square link).

### Enterprise is sales-only — no Square link

Enterprise ($5,000+/year) has **no self-serve button** by design (the license
server cannot currently auto-mint the `enterprise` tier). It links to
`mailto:Support@GoZippy.com`. Do not add a Payment Link for it.

## REQUIRED: Square post-checkout redirect

In **each** Square Payment Link's settings, set the redirect (confirmation) URL to:

```
https://license.gozippy.com/thank-you
```

That page is already live. It echoes the order id + email and gives activation
steps: the customer receives the license token by email, then pastes it into the
extension at **Settings -> About -> "Have a license key?"** (or sets
`DRK_LICENSE_KEY`).

## Assets

The brand logo is loaded remotely from
`https://license.gozippy.com/assets/logo.png`, so no image files need to ship in
this folder. If you'd rather host it locally, download it into `drk/` and update
the `src` / `href` references.

## Pricing source of truth

The binding source of truth is **LICENSE Schedule A**. Keep these pages in sync
with it (and with the README License section, `docs/ROADMAP.md`, and
`docs/MARKETPLACE_LISTING_DRAFT.md`). Notably:

- Do **not** reintroduce the retired "$89/year" figure.
- Do **not** use "SLA / guaranteed response time" language (LICENSE §5.7 forbids
  SLA claims) — say "best-effort, not an SLA".
- Use "tamper-evident", never "tamper-proof".
- AES-256 encryption at rest is included in **all** tiers, including Free.
