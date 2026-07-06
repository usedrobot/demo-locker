#!/usr/bin/env bash
# Smoke test for the standalone image: build, boot, sign up, upload,
# range-stream, comment, restart, verify persistence.
set -euo pipefail

IMAGE="${IMAGE:-demo-locker-standalone:smoke}"
PORT="${PORT:-3401}"
BASE="http://localhost:${PORT}"

docker build --target standalone -t "$IMAGE" .

cleanup() {
  docker rm -f dl-smoke >/dev/null 2>&1 || true
  docker volume rm dl-smoke-data >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker volume create dl-smoke-data >/dev/null
docker run -d --name dl-smoke -v dl-smoke-data:/data -p "${PORT}:3001" "$IMAGE" >/dev/null

wait_healthy() {
  for _ in $(seq 1 60); do
    if curl -fsS "$BASE/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "FAIL: server never became healthy"; docker logs dl-smoke; exit 1
}
wait_healthy

echo "→ signup"
TOKEN=$(curl -fsS -X POST "$BASE/auth/signup" \
  -H 'Content-Type: application/json' \
  -d '{"email":"smoke@test.dev","password":"smoketest123"}' | jq -re .token)

echo "→ create playlist"
PLAYLIST_ID=$(curl -fsS -X POST "$BASE/playlists" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"smoke"}' | jq -re .playlist.id)

echo "→ upload track"
python3 - <<'EOF'
import struct
data = b"\x00" * 3200
with open("/tmp/dl-smoke.wav", "wb") as f:
    f.write(b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt "
            + struct.pack("<IHHIIHH", 16, 1, 1, 8000, 16000, 2, 16)
            + b"data" + struct.pack("<I", len(data)) + data)
EOF
TRACK_ID=$(curl -fsS -X POST "$BASE/tracks/upload" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/tmp/dl-smoke.wav;type=audio/wav" \
  -F "playlistId=$PLAYLIST_ID" | jq -re .track.id)

echo "→ range stream"
STATUS=$(curl -fsS -o /dev/null -w '%{http_code}' -H "Range: bytes=0-99" \
  "$BASE/tracks/$TRACK_ID/stream")
[ "$STATUS" = "206" ] || { echo "FAIL: expected 206, got $STATUS"; exit 1; }

echo "→ comment"
curl -fsS -X POST "$BASE/comments" \
  -H 'Content-Type: application/json' \
  -d "{\"trackId\":\"$TRACK_ID\",\"authorName\":\"smoke\",\"body\":\"sounds rough. ship it.\",\"timestampSec\":0.1}" \
  | jq -re .comment.id >/dev/null || { echo "FAIL: comment"; exit 1; }

echo "→ SPA served"
INDEX_HTML=$(curl -fsS "$BASE/")
echo "$INDEX_HTML" | grep -qi "<!doctype html" || { echo "FAIL: no SPA at /"; exit 1; }

echo "→ hashed asset served correctly"
ASSET_PATH=$(echo "$INDEX_HTML" | grep -oE '/assets/[^"]+\.js' | head -1)
[ -n "$ASSET_PATH" ] || { echo "FAIL: no /assets/*.js reference found in index.html"; exit 1; }
ASSET_HEADERS=$(curl -fsS -D - -o /dev/null "$BASE$ASSET_PATH")
ASSET_STATUS=$(echo "$ASSET_HEADERS" | head -1 | grep -oE '[0-9]{3}')
[ "$ASSET_STATUS" = "200" ] || { echo "FAIL: expected 200 for $ASSET_PATH, got $ASSET_STATUS"; exit 1; }
echo "$ASSET_HEADERS" | grep -qi '^content-type:.*javascript' \
  || { echo "FAIL: $ASSET_PATH missing javascript content-type"; exit 1; }
echo "$ASSET_HEADERS" | grep -qi '^cache-control:.*immutable' \
  || { echo "FAIL: asset missing immutable Cache-Control"; exit 1; }

echo "→ restart container, verify persistence"
docker restart dl-smoke >/dev/null
wait_healthy
curl -fsS "$BASE/playlists" -H "Authorization: Bearer $TOKEN" \
  | jq -re '.playlists[] | select(.name=="smoke") | .id' >/dev/null \
  || { echo "FAIL: playlist did not survive restart"; exit 1; }

echo "SMOKE OK"
