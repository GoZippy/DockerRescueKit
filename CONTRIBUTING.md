# Contributing to DockerRescueKit

Thank you for your interest in contributing. This document covers how to report bugs, suggest features, and submit code.

---

## Reporting Bugs

1. Check [existing issues](https://github.com/gozippy/DockerRescueKit/issues) first
2. Open a new issue and include:
   - Windows version (run `winver`)
   - WSL version (run `wsl --version`)
   - Docker Desktop version (if applicable)
   - The full log file from `%USERPROFILE%\Desktop\WSL_Update_Logs\`
   - Exact error message and the command you ran
   - Steps to reproduce

## Suggesting Features

Open a [GitHub Discussion](https://github.com/gozippy/DockerRescueKit/discussions) describing the use case and the problem it solves. Include examples where possible.

---

## Submitting Code

### Setup

```powershell
git clone https://github.com/gozippy/DockerRescueKit.git
cd DockerRescueKit
```

The PowerShell scripts in `tools/` have no dependencies beyond PowerShell 5.1 and WSL. The Node.js backend under `packages/` requires Node 18+ and npm.

```bash
# Backend only
cd packages/backend
npm install
npm run dev
```

### Branch naming

```
feature/short-description
fix/issue-number-short-description
docs/what-changed
```

### Coding standards for PowerShell scripts

These scripts must run on PowerShell 5.1 (the version built into Windows 10/11). A few constraints apply that are easy to overlook:

**ASCII only in executable string literals.** PowerShell 5.1 reads `.ps1` files as CP1252 by default. Multi-byte UTF-8 characters (em dashes, box-drawing characters, smart quotes, arrows) get corrupted and cause parse errors at runtime. Use only plain ASCII in any string that will be executed — separators, log messages, script content written to files.

**No PowerShell 7+ syntax.** Specifically: no `??` null-coalescing operator, no `?.` null-conditional, no `-Parallel` on `ForEach-Object`.

**Do not shadow automatic variables.** `$Matches`, `$Error`, `$Input`, `$Args`, and similar are PowerShell automatic variables. Use distinct names for local variables.

**CRLF in bash heredocs.** When a PowerShell here-string (`@'...'@` or `@"..."@`) is passed to `wsl -- bash -s`, PowerShell's CRLF line endings reach bash as literal `\r` characters. Always strip them: `$Script -replace "`r`n", "`n"` before passing to WSL.

### Adding a new distro or package manager

The package manager detection logic is in `Get-BashUpdateScript` inside `tools/Update-All-WSL.ps1`. The bash `detect_pm()` function at the top of the generated script handles detection and sets `$PM`. Add a new `elif` branch there and a corresponding `run_upgrade` case. Open a PR with a brief note on which distro you tested it against.

### Testing

Run the dry-run mode against your own WSL setup before submitting:

```powershell
.\tools\Update-All-WSL.ps1 -DryRun
.\tools\Invoke-DockerUpdateSafe.ps1 -DryRun
```

Confirm: no parse errors, distros detected correctly, Docker images classified correctly, no personal paths or credentials in output.

---

## Pull Request Checklist

- [ ] No non-ASCII characters in PowerShell executable string literals
- [ ] No personal paths, usernames, IP addresses, or credentials anywhere in the diff
- [ ] Dry-run tested and output reviewed
- [ ] `CHANGELOG.md` updated under `[Unreleased]`
- [ ] Comments explain *why*, not just *what*

---

## Code of Conduct

Be respectful and constructive. We follow the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).

---

## Contact

Open an issue or start a discussion on GitHub. That is the best way to reach the maintainers.

[github.com/gozippy/DockerRescueKit](https://github.com/gozippy/DockerRescueKit)
