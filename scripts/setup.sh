#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "Installing dependencies..."
npm install

echo "Building packages..."
npm run build

echo "Installing Playwright browsers..."
# All three are required: chromium drives every core flow, but the cross-browser and
# device-matrix flows (part of the default "ui" area) launch real Firefox/WebKit browsers
# too. Installing chromium alone makes those flows fail every run with a Playwright
# "Executable doesn't exist" error, misreported as a HIGH-severity site bug.
npx playwright install chromium firefox webkit

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi

mkdir -p sessions

echo ""
echo "Setup complete! Run: npm run dev"
echo "  Web UI:  http://localhost:5173"
echo "  API:     http://localhost:3001"
