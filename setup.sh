#!/usr/bin/env bash
# Interview Helper — quick setup script
set -e

echo "================================================"
echo "  Interview Helper — Setup"
echo "================================================"
echo ""

# Check node
if ! command -v node &>/dev/null; then
  echo "❌  Node.js not found. Install from https://nodejs.org (v18+)"
  exit 1
fi

NODE_VER=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_VER" -lt 18 ]; then
  echo "⚠   Node.js $NODE_VER found. Recommend v18+."
fi

echo "✅  Node.js $(node -v) found"
echo ""
echo "📦  Installing dependencies..."
npm install

echo ""
echo "✅  Done! To start the app:"
echo "    npm start"
echo ""
echo "📦  To build distributables:"
echo "    npm run build:mac    (macOS Intel DMG)"
echo "    npm run build:win    (Windows NSIS installer)"
echo ""
echo "📝  Remember to:"
echo "    1. Get NVIDIA API key from https://build.nvidia.com"
echo "    2. Open Settings tab and enter your key"
echo "    3. Add your resume in the Context tab"
echo ""
