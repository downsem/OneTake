#!/usr/bin/env bash
set -euo pipefail

echo "Checking release files..."

required_files=(
  "app.json"
  "eas.json"
  ".env.example"
  "firebase/firestore.rules"
  "firebase/storage.rules"
  "docs/PRIVACY_POLICY.md"
  "docs/SUPPORT.md"
  "docs/RELEASE_CHECKLIST.md"
)

for f in "${required_files[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "Missing: $f"
    exit 1
  fi
done

echo "All required release files are present ✅"
