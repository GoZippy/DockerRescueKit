import type { SmokeCheck } from './types';
/**
 * Pre-made smoke-check sets for the 6 stacks documented in
 * docs/STACK_RECIPES.md. Used by the rehearsal wizard (R-2) so users
 * don't have to author probes from scratch for popular apps.
 *
 * Naming convention: keys match the `name:` field in the stack recipe
 * doc so future tooling can cross-reference.
 */
export declare const SMOKE_CHECK_TEMPLATES: Record<string, SmokeCheck[]>;
