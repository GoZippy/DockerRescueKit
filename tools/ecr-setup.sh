#!/usr/bin/env bash
# ECR setup script — run once to create the ECR repositories and configure
# push/pull permissions for the CI workflow.
#
# Prerequisites:
#   - AWS CLI v2 configured with credentials that have ecr:* permissions
#   - AWS_ACCOUNT_ID and AWS_REGION exported or set below
#
# Usage:
#   ./tools/ecr-setup.sh [--region us-east-1] [--account <12-digit-id>]

set -euo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-}"
REPO_EXTENSION="dockerrescuekit"
REPO_STANDALONE="dockerrescuekit-standalone"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region)    AWS_REGION="$2"; shift 2 ;;
    --account)   AWS_ACCOUNT_ID="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [[ -z "$AWS_ACCOUNT_ID" ]]; then
  AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) || {
    echo "ERROR: Cannot determine AWS account. Pass --account or configure AWS CLI."
    exit 1
  }
fi

echo "=== ECR setup for account $AWS_ACCOUNT_ID in $AWS_REGION ==="

# ── 1. Create ECR repositories ────────────────────────────────────────────────
for REPO in "$REPO_EXTENSION" "$REPO_STANDALONE"; do
  echo "--- Creating repository: $REPO ---"
  aws ecr create-repository \
    --repository-name "$REPO" \
    --region "$AWS_REGION" \
    --image-scanning-configuration scanOnPush=true \
    --encryption-configuration encryptionType=AES256 \
    2>/dev/null || echo "  (already exists — skipping)"
done

# ── 2. Lifecycle policies (keep costs down) ───────────────────────────────────
# Keep last 10 tagged images per repo; expire untagged after 7 days.
LIFECODY_POLICY='{
  "rules": [
    {
      "rulePriority": 1,
      "description": "Keep last 10 tagged images",
      "selection": {
        "tagStatus": "tagged",
        "tagPrefixList": ["v"],
        "countType": "imageCountMoreThan",
        "countNumber": 10
      },
      "action": { "type": "expire" }
    },
    {
      "rulePriority": 2,
      "description": "Expire untagged after 7 days",
      "selection": {
        "tagStatus": "untagged",
        "countType": "sinceImagePushed",
        "countUnit": "days",
        "countNumber": 7
      },
      "action": { "type": "expire" }
    }
  ]
}'

for REPO in "$REPO_EXTENSION" "$REPO_STANDALONE"; do
  echo "--- Setting lifecycle policy: $REPO ---"
  aws ecr put-lifecycle-policy \
    --repository-name "$REPO" \
    --region "$AWS_REGION" \
    --lifecycle-policy-text "$LIFECODY_POLICY"
done

# ── 3. Output CI secrets needed ───────────────────────────────────────────────
echo ""
echo "=== Setup complete. Add these GitHub repo secrets ==="
echo ""
echo "  AWS_ACCOUNT_ID       = $AWS_ACCOUNT_ID"
echo "  AWS_REGION           = $AWS_REGION"
echo "  AWS_ROLE_TO_ASSUME   = <ARN of the CI IAM role (see below)>"
echo ""
echo "=== Create the CI IAM role ==="
echo "Create an IAM role with a trust policy allowing GitHub OIDC, then attach"
echo "the following managed policy for ECR push:"
echo ""
cat <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:PutImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:CreateRepository",
        "ecr:PutLifecyclePolicy"
      ],
      "Resource": "*"
    }
  ]
}
EOF
echo ""
echo "ECR image URIs:"
echo "  Extension:  ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${REPO_EXTENSION}"
echo "  Standalone: ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${REPO_STANDALONE}"
