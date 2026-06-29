#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "Installing dependencies..."
npm install

echo "Building packages..."
npm run build

echo "Installing Playwright browsers..."
npx playwright install chromium

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi

mkdir -p sessions

echo ""
echo "Setup complete! Run: npm run dev"
echo "  Web UI:  http://localhost:5173"
echo "  API:     http://localhost:3001"
