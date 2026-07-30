"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SMOKE_CHECK_TEMPLATES = exports.SCRUB_ENV_DEFAULT_PATTERNS = void 0;
/** Default regex patterns matched against env-var names on the source
 *  container; any matching var is stripped from the stand-in unless the
 *  request lists it in `options.allowEnvVars`. Case-insensitive. */
exports.SCRUB_ENV_DEFAULT_PATTERNS = [
    /_TOKEN$/i,
    /_SECRET$/i,
    /_KEY$/i,
    /_PASSWORD$/i,
    /^AWS_/i,
    /^STRIPE_/i,
    /^LICENSE_/i,
    /^OAUTH_/i,
    /^DATABASE_URL$/i, // contains creds; rehearsals must declare allowEnvVars to keep it
];
// Smoke-check templates live in a sibling module so the table doesn't
// bulk up this file. Re-exported here so consumers can keep using the
// single `@docker-rescue-kit/shared` import path.
var smokeCheckTemplates_1 = require("./smokeCheckTemplates");
Object.defineProperty(exports, "SMOKE_CHECK_TEMPLATES", { enumerable: true, get: function () { return smokeCheckTemplates_1.SMOKE_CHECK_TEMPLATES; } });
