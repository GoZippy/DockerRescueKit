# Third-Party License Attribution

DockerRescueKit ships with the following third-party dependencies. Each dependency is licensed under the terms shown. Full license texts are available in the source repository of each package.

The complete machine-readable inventory (all 1 backend dependencies including transitive deps) is checked into the repository as `THIRD_PARTY_LICENSES.json`. The table below lists the first 50 entries in alphabetical order as a quick reference.

## Backend Dependencies (top 50 of 1)

| Package | Version | License | Repository |
|---------|---------|---------|------------|
| @docker-rescue-kit/backend | 1.0.0 | UNLICENSED | — |


## CLI Dependencies

The CLI ships with 24 runtime dependencies (most are transitive from `axios`):

| Package | Version | License | Repository |
|---------|---------|---------|------------|
| asynckit | 0.4.0 | MIT | [link](https://github.com/alexindigo/asynckit) |
| axios | 1.16.0 | MIT | [link](https://github.com/axios/axios) |
| call-bind-apply-helpers | 1.0.2 | MIT | [link](https://github.com/ljharb/call-bind-apply-helpers) |
| combined-stream | 1.0.8 | MIT | [link](https://github.com/felixge/node-combined-stream) |
| delayed-stream | 1.0.0 | MIT | [link](https://github.com/felixge/node-delayed-stream) |
| drk-cli-licenses-temp | 1.0.0 | UNLICENSED | — |
| dunder-proto | 1.0.1 | MIT | [link](https://github.com/es-shims/dunder-proto) |
| es-define-property | 1.0.1 | MIT | [link](https://github.com/ljharb/es-define-property) |
| es-errors | 1.3.0 | MIT | [link](https://github.com/ljharb/es-errors) |
| es-object-atoms | 1.1.1 | MIT | [link](https://github.com/ljharb/es-object-atoms) |
| es-set-tostringtag | 2.1.0 | MIT | [link](https://github.com/es-shims/es-set-tostringtag) |
| follow-redirects | 1.16.0 | MIT | [link](https://github.com/follow-redirects/follow-redirects) |
| form-data | 4.0.5 | MIT | [link](https://github.com/form-data/form-data) |
| function-bind | 1.1.2 | MIT | [link](https://github.com/Raynos/function-bind) |
| get-intrinsic | 1.3.0 | MIT | [link](https://github.com/ljharb/get-intrinsic) |
| get-proto | 1.0.1 | MIT | [link](https://github.com/ljharb/get-proto) |
| gopd | 1.2.0 | MIT | [link](https://github.com/ljharb/gopd) |
| has-symbols | 1.1.0 | MIT | [link](https://github.com/inspect-js/has-symbols) |
| has-tostringtag | 1.0.2 | MIT | [link](https://github.com/inspect-js/has-tostringtag) |
| hasown | 2.0.3 | MIT | [link](https://github.com/inspect-js/hasOwn) |
| math-intrinsics | 1.1.0 | MIT | [link](https://github.com/es-shims/math-intrinsics) |
| mime-db | 1.52.0 | MIT | [link](https://github.com/jshttp/mime-db) |
| mime-types | 2.1.35 | MIT | [link](https://github.com/jshttp/mime-types) |
| proxy-from-env | 2.1.0 | MIT | [link](https://github.com/Rob--W/proxy-from-env) |


## License Summary

The following license families appear across the combined backend + CLI dependency tree:

- **MIT** — 23 package(s)
- **UNLICENSED** — 2 package(s)

## Regenerating This File

Run from the backend workspace (with deps installed):

```bash
cd packages/backend
npx license-checker --production --json > ../../THIRD_PARTY_LICENSES.json
```

Then regenerate the markdown summary using `tools/gen_licenses.js` (or by hand).
