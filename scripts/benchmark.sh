#!/bin/bash
# Benchmark codegraph on a real codebase
# Usage: ./scripts/benchmark.sh [path-to-ts-project]
# Default: clones Excalidraw to /tmp if no path given

set -e

CLI="$(cd "$(dirname "$0")/.." && pwd)/dist/cli.js"
PROJECT="${1:-}"

if [ -z "$PROJECT" ]; then
  if [ ! -d "/tmp/excalidraw" ]; then
    echo "Cloning Excalidraw for benchmarking..."
    git clone --depth 1 https://github.com/excalidraw/excalidraw.git /tmp/excalidraw 2>&1 | tail -1
  fi
  PROJECT="/tmp/excalidraw"
fi

cd "$PROJECT"

FILE_COUNT=$(find . -name "*.ts" -o -name "*.tsx" | grep -v node_modules | wc -l | xargs)
echo "============================================"
echo "  codegraph benchmark"
echo "  project: $PROJECT"
echo "  files: $FILE_COUNT TypeScript files"
echo "============================================"
echo ""

# Build
echo "Building codegraph..."
cd "$(dirname "$CLI")/.."
npx tsc 2>&1
cd "$PROJECT"
echo ""

# --- Without watch mode ---
echo "WITHOUT WATCH MODE (cold start each invocation)"
echo "------------------------------------------------"

# Pick a common symbol
SYMBOL="ExcalidrawElement"

echo ""
echo "1. refs --of $SYMBOL"
FULL_START=$(python3 -c "import time; print(int(time.time()*1000))")
R=$(node "$CLI" refs --of "$SYMBOL" 2>/dev/null)
FULL_END=$(python3 -c "import time; print(int(time.time()*1000))")
OP_MS=$(echo "$R" | grep '"duration_ms"' | head -1 | grep -o '[0-9]*')
TOTAL_MS=$((FULL_END - FULL_START))
TOTAL_REFS=$(echo "$R" | grep '"total_references"' | grep -o '[0-9]*')
COLD_START=$((TOTAL_MS - OP_MS))
echo "   References: $TOTAL_REFS"
echo "   Cold start: ${COLD_START}ms"
echo "   Operation:  ${OP_MS}ms"
echo "   Total:      ${TOTAL_MS}ms"

echo ""
echo "2. impact --of $SYMBOL"
FULL_START=$(python3 -c "import time; print(int(time.time()*1000))")
R=$(node "$CLI" impact --of "$SYMBOL" 2>/dev/null)
FULL_END=$(python3 -c "import time; print(int(time.time()*1000))")
OP_MS=$(echo "$R" | grep '"duration_ms"' | head -1 | grep -o '[0-9]*')
TOTAL_MS=$((FULL_END - FULL_START))
FILES=$(echo "$R" | grep '"files_affected"' | grep -o '[0-9]*')
echo "   Files affected: $FILES"
echo "   Operation:      ${OP_MS}ms"
echo "   Total:          ${TOTAL_MS}ms"

echo ""
echo "3. rename --dry-run --symbol $SYMBOL --to ${SYMBOL}2"
FULL_START=$(python3 -c "import time; print(int(time.time()*1000))")
R=$(node "$CLI" rename --symbol "$SYMBOL" --to "${SYMBOL}2" --dry-run 2>/dev/null)
FULL_END=$(python3 -c "import time; print(int(time.time()*1000))")
OP_MS=$(echo "$R" | grep '"duration_ms"' | head -1 | grep -o '[0-9]*')
TOTAL_MS=$((FULL_END - FULL_START))
LOCS=$(echo "$R" | grep '"total_locations"' | grep -o '[0-9]*')
FILES=$(echo "$R" | grep '"files_affected"' | grep -o '[0-9]*')
echo "   Locations: $LOCS across $FILES files"
echo "   Operation: ${OP_MS}ms"
echo "   Total:     ${TOTAL_MS}ms"

echo ""
echo "4. check-unused --symbol actionFlipHorizontal"
FULL_START=$(python3 -c "import time; print(int(time.time()*1000))")
R=$(node "$CLI" check-unused --symbol actionFlipHorizontal 2>/dev/null)
FULL_END=$(python3 -c "import time; print(int(time.time()*1000))")
OP_MS=$(echo "$R" | grep '"duration_ms"' | head -1 | grep -o '[0-9]*')
TOTAL_MS=$((FULL_END - FULL_START))
echo "   Operation: ${OP_MS}ms"
echo "   Total:     ${TOTAL_MS}ms"

# --- With watch mode ---
echo ""
echo ""
echo "WITH WATCH MODE (persistent server)"
echo "------------------------------------"

node "$CLI" watch &
WATCH_PID=$!
sleep 5
echo "Watch server started (PID $WATCH_PID)"
echo ""

echo "1. refs --of $SYMBOL"
R=$(node "$CLI" refs --of "$SYMBOL" 2>/dev/null)
OP_MS=$(echo "$R" | grep '"duration_ms"' | head -1 | grep -o '[0-9]*')
TOTAL_REFS=$(echo "$R" | grep '"total_references"' | grep -o '[0-9]*')
echo "   References: $TOTAL_REFS | Operation: ${OP_MS}ms"

echo ""
echo "2. impact --of $SYMBOL"
R=$(node "$CLI" impact --of "$SYMBOL" 2>/dev/null)
OP_MS=$(echo "$R" | grep '"duration_ms"' | head -1 | grep -o '[0-9]*')
FILES=$(echo "$R" | grep '"files_affected"' | grep -o '[0-9]*')
echo "   Files affected: $FILES | Operation: ${OP_MS}ms"

echo ""
echo "3. rename --dry-run --symbol $SYMBOL --to ${SYMBOL}2"
R=$(node "$CLI" rename --symbol "$SYMBOL" --to "${SYMBOL}2" --dry-run 2>/dev/null)
OP_MS=$(echo "$R" | grep '"duration_ms"' | head -1 | grep -o '[0-9]*')
LOCS=$(echo "$R" | grep '"total_locations"' | grep -o '[0-9]*')
FILES=$(echo "$R" | grep '"files_affected"' | grep -o '[0-9]*')
echo "   Locations: $LOCS across $FILES files | Operation: ${OP_MS}ms"

echo ""
echo "4. check-unused --symbol actionFlipHorizontal"
R=$(node "$CLI" check-unused --symbol actionFlipHorizontal 2>/dev/null)
OP_MS=$(echo "$R" | grep '"duration_ms"' | head -1 | grep -o '[0-9]*')
echo "   Operation: ${OP_MS}ms"

echo ""
echo "5. Second run (warmed up)"
R=$(node "$CLI" refs --of "$SYMBOL" 2>/dev/null)
OP_MS1=$(echo "$R" | grep '"duration_ms"' | head -1 | grep -o '[0-9]*')
R=$(node "$CLI" rename --symbol "$SYMBOL" --to "${SYMBOL}2" --dry-run 2>/dev/null)
OP_MS2=$(echo "$R" | grep '"duration_ms"' | head -1 | grep -o '[0-9]*')
R=$(node "$CLI" impact --of "$SYMBOL" 2>/dev/null)
OP_MS3=$(echo "$R" | grep '"duration_ms"' | head -1 | grep -o '[0-9]*')
echo "   refs: ${OP_MS1}ms | rename: ${OP_MS2}ms | impact: ${OP_MS3}ms"

# Kill watch
kill $WATCH_PID 2>/dev/null
wait $WATCH_PID 2>/dev/null

echo ""
echo "============================================"
echo "  Benchmark complete"
echo "============================================"
