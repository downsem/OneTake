#!/usr/bin/env bash
set -euo pipefail

echo "Checking final pack files..."

required_files=(
  "App.js"
  "src/lib/firebase.js"
  "src/lib/storage.js"
  "src/lib/notifications.js"
  "src/services/takesService.js"
  "src/services/profileService.js"
  "src/services/promptsService.js"
  "firebase/firestore.rules"
  "firebase/storage.rules"
  "docs/RELEASE_CHECKLIST_FINAL.md"
)

for f in "${required_files[@]}"; do
  [[ -f "$f" ]] || { echo "Missing: $f"; exit 1; }
done

echo "Final pack files present ✅"
