import { featuresForTier, LicenseTier } from '../services/LicenseService'

/**
 * Tier → feature CONTRACT snapshot.
 *
 * This is the verifier-side source of truth. The license server
 * (DRK_LicenseServer: src/routes/license.ts + src/routes/webhooks.ts) mints
 * tokens against its OWN copies of this map. The two repos must stay in sync —
 * if the server grants a feature this map doesn't list, LicenseService scopes
 * it away; if it grants fewer, a paying customer is under-served.
 *
 * If you change FEATURES_BY_TIER, this test fails on purpose. Update the
 * snapshot below AND the license server's two FEATURES_BY_TIER copies in the
 * same change. Do not "fix" the test without doing the server side.
 */
const EXPECTED: Record<LicenseTier, string[]> = {
  free: [],
  'personal-pro': [
    'audit_log_90d',
    'byok_encryption',
    'notifications',
    'unlimited_policies',
  ],
  'commercial-pro': [
    'audit_log_365d',
    'byok_encryption',
    'multi_host_fleet',
    'notifications',
    'unlimited_policies',
  ],
  enterprise: [
    'audit_log_unlimited',
    'byok_encryption',
    'compliance_docs',
    'managed_cloud_backup',
    'msp_white_label',
    'multi_host_fleet',
    'notifications',
    'rbac',
    'sso',
    'unlimited_policies',
    'worm',
  ],
}

describe('FEATURES_BY_TIER contract (keep in sync with DRK_LicenseServer)', () => {
  const tiers = Object.keys(EXPECTED) as LicenseTier[]

  it.each(tiers)('tier "%s" grants exactly the contracted features', (tier) => {
    // EXPECTED is pre-sorted; featuresForTier sorts too.
    expect(featuresForTier(tier)).toEqual([...EXPECTED[tier]].sort())
  });

  it('every paid tier includes the Free tier as a subset (monotonic upgrade)', () => {
    const order: LicenseTier[] = ['free', 'personal-pro', 'commercial-pro', 'enterprise']
    for (let i = 1; i < order.length; i++) {
      const lower = new Set(featuresForTier(order[i - 1]))
      const higher = new Set(featuresForTier(order[i]))
      // personal-pro→commercial-pro→enterprise are strictly additive in our model.
      for (const f of lower) {
        if (order[i - 1] === 'personal-pro' && f.startsWith('audit_log_')) continue
        if (order[i - 1] === 'commercial-pro' && f.startsWith('audit_log_')) continue
        expect(higher.has(f)).toBe(true)
      }
    }
  })
})
