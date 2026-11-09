#!/usr/bin/env bash
# Puts this tool on a boat.dev cloud machine and copies your setup to it.
#   scripts/boat-setup.sh            make a new machine
#   scripts/boat-setup.sh bx_xxxx    set up (or refresh) one you already have
# Copies: data/profile.json, bank.json, voice.local.md, target.json, imports/, queue.json,
# the resume the profile names, and .env (your keys go onto the machine).
set -euo pipefail
BOAT="${BOAT:-$HOME/.ascii/bin/boat}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE_DIR="jev-job-search"
cd "$ROOT"

ID="${1:-}"
if [ -z "$ID" ]; then
  echo "Creating a boat machine (4 vCPU / 8 GB, about \$0.036 an hour while it runs)..."
  ID="$("$BOAT" new --type default 2>&1 | grep -oE 'bx_[a-z0-9]+' | head -1)"
  [ -n "$ID" ] || { echo "boat did not return a machine id. Run: $BOAT limits"; exit 1; }
fi
echo "Machine: $ID"
run() { "$BOAT" exec "$ID" --timeout 600 -- bash -lc "$1"; }

echo "Getting the code and Node 22..."
run "set -e
  if [ -d ~/$REMOTE_DIR/.git ]; then git -C ~/$REMOTE_DIR pull -q; else git clone -q https://github.com/Trav54219/jev-job-search ~/$REMOTE_DIR; fi
  major=\$(node -p 'process.versions.node.split(\".\")[0]' 2>/dev/null || echo 0)
  if [ \"\$major\" -lt 22 ]; then sudo npm i -g -s n && sudo n 22 >/dev/null; fi
  cd ~/$REMOTE_DIR && npm ci --silent"

echo "Copying your profile, drafts, voice, target, imports and queue..."
run "mkdir -p ~/$REMOTE_DIR/data/imports ~/$REMOTE_DIR/data/resume"
for f in data/profile.json data/bank.json data/voice.local.md data/target.json data/queue.json; do
  [ -f "$f" ] && "$BOAT" scp "$f" "$ID:$REMOTE_DIR/$f"
done
for f in data/imports/*.csv; do [ -f "$f" ] && "$BOAT" scp "$f" "$ID:$REMOTE_DIR/$f"; done

RESUME="$(python3 -I -c 'import json;print(json.load(open("data/profile.json"))["resume"]["path"])')"
RESUME_NAME="$(basename "$RESUME")"
"$BOAT" scp "$RESUME" "$ID:$REMOTE_DIR/data/resume/$RESUME_NAME"

echo "Copying .env (Open Gateway key; Chrome path set for Linux)..."
TMP_ENV="$(mktemp)"
grep -v '^CHROME_PATH=' .env > "$TMP_ENV"
"$BOAT" scp "$TMP_ENV" "$ID:$REMOTE_DIR/.env"
rm -f "$TMP_ENV"

run "set -e; cd ~/$REMOTE_DIR
  python3 - <<'PY'
import json, os
p='data/profile.json'; d=json.load(open(p))
d['resume']['path']=os.path.expanduser('~/$REMOTE_DIR/data/resume/$RESUME_NAME')
json.dump(d, open(p,'w'), indent=2)
PY
  chrome=\$(command -v google-chrome || command -v google-chrome-stable || command -v chromium || true)
  [ -n \"\$chrome\" ] && printf '\nCHROME_PATH=%s\n' \"\$chrome\" >> .env
  grep -q '^DISPLAY=' .env || printf 'DISPLAY=%s\n' \"\${DISPLAY:-:0}\" >> .env
  npx jev doctor || true"

echo
echo "Done. Watch Chrome:   $BOAT desktop $ID"
echo "Shell in:             $BOAT ssh $ID   then   cd ~/$REMOTE_DIR"
echo "Stop billing:         $BOAT stop $ID   (disk kept 14+ days, resume with $BOAT resume $ID)"
