#!/usr/bin/env bash
set -e

trap 'kill 0' EXIT

echo "Starting backend..."
(cd backend && cargo run) &

echo "Starting frontend..."
(cd frontend && npm run dev -- --open) &

wait
