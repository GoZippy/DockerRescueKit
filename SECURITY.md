# Security Policy

## Supported Versions

Only the versions listed below receive security updates.

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |
| 0.2.x   | :x:                |
| 0.1.x   | :x:                |
| < 0.1   | :x:                |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

### How to Report

You have two options:

1. **Email:** Please report vulnerabilities to `gotadvantage@gmail.com` with subject prefix `[DRK SECURITY]`.
2. **GitHub Security Advisory:** Open a [GitHub Security Advisory](https://github.com/dockerrescuekit/docker-rescue-kit/security/advisories/new) directly in this repository. This keeps the report private until a fix is ready.

### What to Include

A useful report includes as many of the following as possible:

- **Description:** A clear summary of the vulnerability, including the type (e.g., injection, auth bypass, information disclosure).
- **Steps to reproduce:** A minimal, reliable sequence of steps or a proof-of-concept that demonstrates the issue.
- **Impact:** What can an attacker achieve? What data or systems are at risk?
- **Affected component:** Which package, endpoint, or feature is affected (e.g., `packages/backend/src/api/auth.ts`).
- **Suggested fix:** If you have a proposed remediation or patch, please include it.

### Response Timeline

| Milestone                                  | Target SLA        |
| ------------------------------------------ | ----------------- |
| Acknowledge receipt of report              | 48 hours          |
| Confirm/deny the vulnerability             | 5 business days   |
| Patch released for **critical** severity   | 14 days           |
| Patch released for **high** severity       | 30 days           |
| Patch released for **medium/low** severity | Next minor release|

We will keep you informed of progress throughout the process. If you do not receive an acknowledgement within 48 hours, please follow up to ensure your message was received.

## Out of Scope

The following categories are **not** considered in-scope for this security policy:

- **Denial of Service (DoS/DDoS):** Resource exhaustion attacks that require high-volume traffic.
- **Social engineering:** Attacks targeting users or maintainers rather than the software itself.
- **Physical access:** Vulnerabilities that require physical access to the host machine.
- **Best-practice recommendations:** Issues that are not exploitable vulnerabilities (e.g., missing headers on non-sensitive endpoints, absence of rate limiting on public read-only APIs).
- **Third-party dependencies:** Vulnerabilities in upstream packages that have already been publicly disclosed. Please report those to the respective upstream maintainers.
- **Self-signed certificates or TLS configuration in development mode.**

## Hall of Fame — Responsible Disclosure

We sincerely thank everyone who has responsibly disclosed security issues to us. Your efforts make DockerRescueKit safer for everyone.

| Researcher | Vulnerability | Date       |
| ---------- | ------------- | ---------- |
| *(none yet — be the first!)* | | |

If you report a confirmed vulnerability and wish to be listed here, let us know in your report whether you would like to be credited and under what name or handle.

## Preferred Languages

We prefer to receive reports in **English**, but will do our best to respond to reports in other languages.
