#!/usr/bin/env bash
# check-rclone.sh — detect rclone and, if missing, recommend (or run) the right
# install for this machine. rclone is the third-party tool DRK uses to reach
# cloud storage (Google Drive, OneDrive, Dropbox, S3, B2, ...).
#
# This script touches NOTHING unless you pass --install. By default it just
# reports what it found and prints the command you'd run.
#
# Usage:
#   ./tools/check-rclone.sh            # report only
#   ./tools/check-rclone.sh --install  # detect a package manager and install
#
# Exit codes: 0 = rclone present (or installed), 1 = missing and not installed.

set -euo pipefail

INSTALL=0
[[ "${1:-}" == "--install" ]] && INSTALL=1

has() { command -v "$1" >/dev/null 2>&1; }

echo "Checking for rclone..."

if has rclone; then
  version="$(rclone version | head -n1)"
  echo "[OK] rclone is installed: ${version}"
  echo "     You're all set. In DRK: Integrations -> Manage remotes."
  exit 0
fi

echo "[--] rclone was not found on PATH."
echo

# Detect OS + the best available installer, in order of preference.
os="$(uname -s)"
method_name=""
method_cmd=""

if [[ "$os" == "Darwin" ]]; then
  if has brew; then method_name="Homebrew"; method_cmd="brew install rclone"
  elif has port; then method_name="MacPorts"; method_cmd="sudo port install rclone"
  else method_name="official script"; method_cmd="curl https://rclone.org/install.sh | sudo bash"; fi
else
  # Linux / other POSIX
  if has apt-get; then method_name="apt"; method_cmd="sudo apt update && sudo apt install -y rclone"
  elif has dnf; then method_name="dnf"; method_cmd="sudo dnf install -y rclone"
  elif has pacman; then method_name="pacman"; method_cmd="sudo pacman -S --noconfirm rclone"
  elif has zypper; then method_name="zypper"; method_cmd="sudo zypper install -y rclone"
  else method_name="official script"; method_cmd="curl https://rclone.org/install.sh | sudo bash"; fi
fi

echo "Recommended install (${method_name}):"
echo "    ${method_cmd}"
echo

if [[ "$INSTALL" -eq 1 ]]; then
  echo "Installing rclone via ${method_name}..."
  # The official script and the package managers above all verify their own
  # downloads; we surface the exact command so there are no surprises.
  bash -c "${method_cmd}"
  if has rclone; then
    echo "[OK] rclone installed: $(rclone version | head -n1)"
    exit 0
  fi
  echo "[!!] Install ran but rclone still isn't on PATH — open a new shell and re-check."
  exit 1
fi

echo "Tip: cautious admins can verify the download's SHA-256 against the published"
echo "     SHA256SUMS on rclone.org before installing. Package managers verify for you."
exit 1
