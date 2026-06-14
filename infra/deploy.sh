#!/bin/bash
set -euo pipefail

# === Configuration ===
# Set these variables before running
FOLDER_ID="${YC_FOLDER_ID:?Set YC_FOLDER_ID}"
SA_ID="${YC_SA_ID:?Set YC_SA_ID}"
REGISTRY_NAME="wheel-of-shame"
CONTAINER_NAME="wheel-of-shame"
BUCKET_NAME="wheel-of-shame-frontend"
API_GW_NAME="wheel-of-shame-gw"
YDB_NAME="wheel-of-shame-db"
IMAGE_TAG="latest"

echo "=== Building backend Docker image ==="
cd "$(dirname "$0")/../backend"
docker build -t "cr.yandex/${FOLDER_ID}/${REGISTRY_NAME}:${IMAGE_TAG}" .

echo "=== Pushing to Yandex Container Registry ==="
docker push "cr.yandex/${FOLDER_ID}/${REGISTRY_NAME}:${IMAGE_TAG}"

# Persistence: the backend defaults to an in-memory store, which loses every
# session whenever the container is replaced (deploy, scale, cold start). We
# pin it to the SQLite backend so sessions survive a container restart.
#
# IMPORTANT: this only persists data if the SQLite file lives on durable
# storage that a SINGLE instance owns. A serverless container's local
# filesystem is ephemeral and is NOT shared between instances, so this
# configuration assumes:
#   - the container runs as a single instance (no horizontal fan-out), and
#   - SQLITE_PATH points at a mounted persistent volume.
# Mount a persistent volume at /data and keep the DB there. If you ever scale
# past one instance, switch STORE_BACKEND to ydb instead. SQLITE_PATH is read
# by build_sqlite() in backend/src/store/mod.rs.
STORE_BACKEND="${STORE_BACKEND:-sqlite}"
SQLITE_PATH="${SQLITE_PATH:-/data/wheel.db}"

echo "=== Creating/updating Serverless Container ==="
echo "Storage backend: ${STORE_BACKEND} (SQLITE_PATH=${SQLITE_PATH})"
yc serverless container revision deploy \
  --container-name "${CONTAINER_NAME}" \
  --image "cr.yandex/${FOLDER_ID}/${REGISTRY_NAME}:${IMAGE_TAG}" \
  --cores 1 \
  --memory 128m \
  --concurrency 4 \
  --execution-timeout 30s \
  --environment "STORE_BACKEND=${STORE_BACKEND},SQLITE_PATH=${SQLITE_PATH}" \
  --service-account-id "${SA_ID}" \
  --folder-id "${FOLDER_ID}"

echo "=== Getting container ID ==="
CONTAINER_ID=$(yc serverless container get --name "${CONTAINER_NAME}" --folder-id "${FOLDER_ID}" --format json | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "Container ID: ${CONTAINER_ID}"

echo "=== Getting API Gateway URL ==="
API_GW_URL=$(yc serverless api-gateway get --name "${API_GW_NAME}" --folder-id "${FOLDER_ID}" --format json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['domain'])" || echo "")

echo "=== Building frontend ==="
cd "$(dirname "$0")/../frontend"
VITE_API_BASE_URL="https://${API_GW_URL}" npm run build

echo "=== Uploading frontend to Object Storage ==="
aws s3 sync dist/ "s3://${BUCKET_NAME}/" --endpoint-url=https://storage.yandexcloud.net --delete

echo "=== Done! ==="
echo "App URL: https://${API_GW_URL}"
