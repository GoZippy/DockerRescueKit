# DockerRescueKit on AWS — Technical Overview

## The Gap

AWS has no first-party backup solution for Docker workloads. If you're running containers on ECS, EC2, or Docker Desktop on a cloud workstation, **you're on your own for backup and restore of container state**. AWS Backup covers EBS volumes, RDS databases, DynamoDB tables, and EFS file systems — but not Docker volumes, container configurations, or compose stack definitions.

DRK fills that gap: it treats the Docker workload itself as the unit of backup, not just the underlying infrastructure.

## Native Integration Points

DRK doesn't require AWS services to work — it runs entirely on local infrastructure (Docker Desktop, a Linux VM, a NAS). But it **complements** native AWS backup in concrete ways:

| Data Source | AWS Native Backup | DRK's Role |
|---|---|---|
| EBS volumes (EC2 instance state) | AWS Backup ✅ | — |
| RDS databases | Automated backups + AWS Backup ✅ | — |
| DynamoDB tables | PITR + AWS Backup ✅ | — |
| EFS file systems | AWS Backup ✅ | — |
| Docker named volumes | ❌ | DRK ✅ |
| Container configuration (env, labels, networks, images) | ❌ | DRK ✅ |
| Compose stack definitions | ❌ | DRK ✅ |
| Application state inside containers | ❌ | DRK ✅ |
| Container secrets (flow, not stored) | ❌ | DRK ✅ |

The integration is additive. If you're on EC2 running Docker containers with data in RDS, you use AWS Backup for RDS and DRK for the Docker layer. DRK's restic/rclone backends can also target **S3 directly** — you back up to an S3 bucket managed by your own lifecycle policies.

### What DRK Backs Up

- **Named volumes**: Full point-in-time snapshots via restic
- **Container configurations**: Image, env vars, labels, networking — everything needed to recreate the container
- **Compose stacks**: Full project definitions including all services, networks, and volumes
- **Backup metadata**: History, verification status, audit log of every operation
- **Encrypted credentials**: Storage vault configs (AES-256-GCM at rest), not the raw secrets

### What DRK Does NOT Back Up

- Actual backup data in remote vaults (restic repos, S3 buckets, rclone remotes) — those are self-managing
- AWS-managed service data (use AWS Backup for that)
- Container images (use ECR for that)

---

## Specific AWS Use Cases

### EC2 + Docker Desktop on Cloud Workstations

AWS is pushing Docker Desktop on cloud workstations heavily. When a developer spins up a workstation, they configure Docker containers for their project. DRK snapshots that project state (volumes, configurations, compose stacks) either to local storage or to S3 via rclone. When the workstation is rebuilt or a new developer joins, DRK restores the full project environment — not just the code (that's in git) but the actual running state (database seeds, cached data, container networking).

**Why it matters**: Cloud workstations are ephemeral. The state developers build up over days (databases with test data, configured services, networking) is lost when the workstation is rebuilt unless something is backing it up.

### ECS Task State Preservation

Before a deployment or scaling event, DRK snapshots the current state of volumes and containers. If the deployment fails, you restore the exact prior state — container configuration, volume data, and all — rather than trying to reconstruct from logs.

**Why it matters**: ECS handles task definition rollback, but not the data inside task storage. DRK gives you a rollback button for the entire Docker environment, not just the task definition.

### Multi-Environment Promotion (Dev → Staging → Prod)

DRK's export/import config flow captures a full environment configuration (policies, storage vaults, backup history) as a JSON bundle. An engineer who built out a complex Docker environment locally can export it, and a teammate or CI pipeline can import it to get an identical setup.

**Why it matters**: Teams using Docker Desktop on AWS workstations each have isolated environments. DRK makes environments portable and reproducible — configuration as code for your Docker state.

### Compliance and Disaster Recovery for Containerized Applications

DRK provides audit logging of all backup operations, encrypted storage, and restore rehearsal — the ability to prove backups actually work by restoring them into an isolated network and running smoke checks. No AWS service offers this for Docker workloads.

**Why it matters**: Teams with regulatory requirements (HIPAA, SOC2) need to demonstrate not just that backups exist, but that they can be restored and verified. DRK's rehearsal feature automates this proof.

### Pre-Flight for Infrastructure Changes

Before upgrading Docker Engine, migrating to new EC2 instance types, or changing VPC networking, DRK snapshots everything, makes the change, and verifies — with a guaranteed rollback path. The restore rehearsal feature spins up isolated containers with the same images and scrubbed environment variables, running operator-defined smoke checks to confirm the restore works before touching production.

**Why it matters**: Infrastructure changes are the highest-risk operations for containerized workloads. DRK gives you a safety net that's specific to the Docker layer.

---

## Why ECR (Amazon Elastic Container Registry)

ECR isn't the integration point — it's the **distribution channel**. Here's why it matters:

### 1. Enterprise Network Restrictions

Many AWS customers (especially in regulated industries) block outbound traffic to Docker Hub at the network level. By mirroring DRK in ECR, these customers can pull the extension from inside their own VPC or through their approved registry. No firewall exceptions needed.

### 2. IAM-Based Access Control

ECR integrates with IAM policies. An organization can enforce "only these roles can pull DRK" and audit all pulls through CloudTrail. Docker Hub tokens don't integrate with AWS IAM — there's no way to control or audit who's pulling your images from inside AWS.

### 3. Security Scanning Pipeline

ECR's built-in image scanning (powered by Clair and Amazon Inspector) feeds into AWS Security Hub. Customers with Security Hub dashboards get DRK's vulnerability posture automatically without running separate Trivy scans. One dashboard, all images, all registries.

### 4. CI/CD with GitHub Actions OIDC

DRK's CI workflow uses GitHub's OIDC provider to assume an AWS IAM role — no long-lived AWS credentials stored in GitHub secrets. This is the pattern AWS recommends for CI/CD pipelines publishing to ECR. DRK serves as a reference implementation of this pattern for other open-source tools.

### 5. ECR Public Gallery Visibility

Developers browsing [gallery.ecr.aws](https://gallery.ecr.aws) (AWS's alternative to Docker Hub) will find DRK alongside other AWS-relevant tools. It's a discovery surface that doesn't exist on Docker Hub — AWS developers looking for Docker tools will find DRK in their native registry.

---

## The Kilo CLI and Kilo Community Angle

Kilo is an interactive CLI tool and configuration layer that DRK ships with. Kilo reads from `.kilo/` config files in the project directory and provides a unified interface for backup policies, scheduled operations, and configuration-as-code.

### How DRK and Kilo Fit Together

- **Kilo as the config layer**: Kilo reads `.kilo/` config files to define DRK backup policies, schedules, and targets. These configs are version-controlled alongside the project.
- **DRK as the execution layer**: DRK runs the actual backup, verify, and restore operations that Kilo configures. DRK handles the Docker API calls, restic/rclone operations, and storage vault management.
- **Together**: Infrastructure-as-code for Docker backup. Engineers define what to back up in Kilo configs (reviewed in PRs), and DRK executes it (audited in logs).

### Relevance to the Kilo Community

If Kilo's audience includes developers building on AWS who use Docker:

1. **Local development loop**: Developers who use Docker Desktop can use DRK to snapshot their development environment state. When their IDE or tooling helps them scaffold a project that involves containers, DRK backs up the resulting state. It's "git for your Docker environment" — code goes in git, environment state goes in DRK.

2. **Workstation portability**: Developers who work across multiple AWS workstations (or between local and cloud) can use DRK's export/import config to make their entire Docker environment portable. Export on workstation A, import on workstation B, and they're running in minutes.

3. **Compliance-as-code for startups**: Startups building on AWS who need to demonstrate compliance (SOC2, HIPAA) early can use DRK's audit log for a verifiable backup trail without building custom tooling. Pair that with Kilo's configuration-as-code and you have a compliance story that auditors can review — backup policies defined in code, reviewed in PRs, executed and audited automatically.

4. **DRK's policy engine**: DRK supports scheduled policies with retention rules, target selection (specific containers, volumes, or full stacks), and hook runners (run custom scripts before/after backup). These policies are defined in Kilo configs and version-controlled. For teams that need to enforce backup standards across a fleet of developer workstations, this is the mechanism.

### The Combined Value Proposition

For AWS developers using Kilo:

- **Kilo** defines the what and when (backup policies, schedules, targets — as code)
- **DRK** does the how (Docker API, restic/rclone, encryption, verification — as execution)
- **Together**: Reproducible, auditable, portable Docker environments that survive workstation rebuilds, team scaling, and compliance audits.

---

## Architecture on AWS — High Level

```
Developer Workstation (EC2 / Cloud9 / Local)
├── Docker Desktop
│   ├── DRK Extension (or standalone container)
│   │   ├── UI (served from /ui in the extension image)
│   │   ├── Backend (Express API)
│   │   │   ├── Policy Manager → schedules backups
│   │   │   ├── Docker Service → Docker Engine API
│   │   │   ├── Storage Factory → restic / rclone / local
│   │   │   ├── Verification Service → integrity checks
│   │   │   └── Rehearsal Service → isolated restore testing
│   │   └── Kilo CLI → .kilo/config files
│   └── Application Containers
│       ├── App containers
│       ├── Database containers
│       └── Cache/queue containers
│
├── Backup Targets (configurable per policy)
│   ├── Local disk (fastest, no redundancy)
│   ├── S3 bucket (durable, restic or rclone)
│   ├── EBS volume (if on EC2)
│   └── SMB/NAS (homelab)
│
└── Audit & Compliance
    ├── Audit log (every operation, JSON, tamper-evident)
    ├── Verification reports (checksums, restore tests)
    └── Export bundle (full config portability)
```

### Key Design Decisions

- **Agentless**: DRK connects to the Docker Engine API — no agent inside containers, no sidecars, no daemonsets. It runs alongside Docker, not inside your application architecture.
- **Backend-agnostic**: Works on Docker Desktop (extension), standalone Linux container, or any host running Docker Engine. The same image runs everywhere.
- **Storage-agnostic**: Local disk, S3, B2, SMB, SFTP, or any of rclone's 40+ backends. DRK doesn't mandate where your backups go.
- **Encryption at rest**: Optional AES-256-GCM encryption for backup data, with per-install key derivation. Even if someone gets your S3 bucket, they can't read the backups.
- **Zero network dependency for core features**: Backup, verify, and restore work without internet access. Only version checking and GitHub feedback submission require connectivity.

---

## Summary

DRK is not a replacement for AWS Backup — it's the layer above it. AWS Backup handles infrastructure; DRK handles the Docker workload that runs on that infrastructure. Published to both Docker Hub and Amazon ECR, it's accessible to every AWS customer regardless of their network constraints or registry preferences.

For the Kilo community, DRK is the execution engine that turns Kilo's backup policy definitions into actual protected, verified, portable Docker state.
