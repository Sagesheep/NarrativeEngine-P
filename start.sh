#!/bin/bash
cd "$(dirname "$0")"

# ===== Pre-flight checks =====
if ! command -v node >/dev/null 2>&1; then
    echo ""
    echo "[STOP] Node.js is not installed on this computer."
    echo ""
    echo "This app needs Node.js to run. To install it:"
    echo "  1. Open your web browser and go to https://nodejs.org/"
    echo "  2. Download the 'LTS' version (the green button)"
    echo "  3. Install it, then run ./start.sh again"
    echo ""
    exit 1
fi

NODE_VERSION=$(node -p "process.versions.node" 2>/dev/null)
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
NODE_MINOR=$(echo "$NODE_VERSION" | cut -d. -f2)
# Strip leading zeros
NODE_MAJOR=$(echo "$NODE_MAJOR" | sed 's/^0*//')
NODE_MINOR=$(echo "$NODE_MINOR" | sed 's/^0*//')
[ -z "$NODE_MAJOR" ] && NODE_MAJOR=0
[ -z "$NODE_MINOR" ] && NODE_MINOR=0

REQUIRED_MAJOR=20
REQUIRED_MINOR=19

NODE_OK=0
if [ "$NODE_MAJOR" -gt "$REQUIRED_MAJOR" ]; then
    NODE_OK=1
elif [ "$NODE_MAJOR" -eq "$REQUIRED_MAJOR" ] && [ "$NODE_MINOR" -ge "$REQUIRED_MINOR" ]; then
    NODE_OK=1
fi

if [ "$NODE_OK" -eq 0 ]; then
    echo ""
    echo "[STOP] Your version of Node.js is too old for this app."
    echo ""
    echo "You have version $NODE_VERSION. The app needs version 20.19 or newer."
    echo ""
    echo "To fix this:"
    echo "  1. Open your web browser and go to https://nodejs.org/"
    echo "  2. Download the 'LTS' version (the green button)"
    echo "  3. Install it, then run ./start.sh again"
    echo ""
    echo "--------------------------------------------"
    echo "Already upgraded Node but the app still won't start?"
    echo "--------------------------------------------"
    echo "There is a second file in this folder called"
    echo "'Repair_Narrative_Engine.sh'. Run it with:"
    echo "  ./Repair_Narrative_Engine.sh"
    echo "It will fix the app's database file to match your"
    echo "new Node version. It will:"
    echo "  - Ask you to type YES before doing anything"
    echo "  - NOT change your Node.js version"
    echo "  - NOT delete your saved campaigns or data"
    echo "  - NOT touch any other programs on your computer"
    echo "You must run that script yourself - this one will"
    echo "not run it for you."
    echo ""
    exit 1
fi

echo "Node $NODE_VERSION detected - OK."
echo ""

# ===== Main flow (unchanged) =====
echo "Installing dependencies..."
npm install
echo "Building engine..."
npm run build --prefix packages/engine
echo "Starting the application..."
(sleep 3 && xdg-open http://localhost:5173) &
npm run dev