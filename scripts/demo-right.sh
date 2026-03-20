#!/bin/bash
# Run this in the RIGHT terminal — shows all codegraph capabilities
cd /tmp/excalidraw
CLI="/Users/apple/Code/Repo/scraps/codegraph/dist/cli.js"

echo "=========================================="
echo "  CODEGRAPH — 6 operations, 1 codebase"
echo "  Excalidraw: 589 TypeScript files"
echo "=========================================="
echo ""

# 1. RENAME
echo "1. RENAME — ExcalidrawElement -> ExcalidrawNode"
echo "   (compiler-resolved, zero false matches)"
RESULT=$(node "$CLI" rename --symbol ExcalidrawElement --to ExcalidrawNode --dry-run 2>/dev/null)
LOCS=$(echo "$RESULT" | grep '"total_locations"' | grep -o '[0-9]*')
FILES=$(echo "$RESULT" | grep '"files_affected"' | grep -o '[0-9]*')
MS=$(echo "$RESULT" | grep '"duration_ms"' | head -1 | grep -o '[0-9]*')
echo "   Result: $LOCS locations across $FILES files in ${MS}ms"
echo ""

# 2. IMPACT ANALYSIS
echo "2. IMPACT — What breaks if I change ExcalidrawElement?"
RESULT=$(node "$CLI" impact --of ExcalidrawElement 2>/dev/null)
REFS=$(echo "$RESULT" | grep '"direct_references"' | grep -o '[0-9]*')
FILES=$(echo "$RESULT" | grep '"files_affected"' | grep -o '[0-9]*')
RISK=$(echo "$RESULT" | grep '"risk_level"' | grep -o '"[a-z]*"' | tail -1 | tr -d '"')
EXPORTED=$(echo "$RESULT" | grep '"is_exported"' | grep -o 'true\|false')
MS=$(echo "$RESULT" | grep '"duration_ms"' | head -1 | grep -o '[0-9]*')
echo "   Result: $REFS refs, $FILES files, exported=$EXPORTED, risk=$RISK in ${MS}ms"
echo ""

# 3. FIND REFERENCES
echo "3. REFS — Where is ExcalidrawElement used?"
RESULT=$(node "$CLI" refs --of ExcalidrawElement 2>/dev/null)
TOTAL=$(echo "$RESULT" | grep '"total_references"' | grep -o '[0-9]*')
MS=$(echo "$RESULT" | grep '"duration_ms"' | head -1 | grep -o '[0-9]*')
echo "   Result: $TOTAL references found in ${MS}ms"
echo ""

# 4. CHECK UNUSED
echo "4. CHECK-UNUSED — Is actionDeleteSelected safe to delete?"
RESULT=$(node "$CLI" check-unused --symbol actionDeleteSelected 2>/dev/null)
UNUSED=$(echo "$RESULT" | grep '"is_unused"' | grep -o 'true\|false')
USAGE=$(echo "$RESULT" | grep '"usage_count"' | grep -o '[0-9]*')
MS=$(echo "$RESULT" | grep '"duration_ms"' | head -1 | grep -o '[0-9]*')
echo "   Result: is_unused=$UNUSED, usage_count=$USAGE in ${MS}ms"
echo ""

# 5. CALLERS
echo "5. CALLERS — Who calls newElementWith?"
RESULT=$(node "$CLI" callers --of newElementWith 2>/dev/null)
COUNT=$(echo "$RESULT" | grep '"caller_count"' | grep -o '[0-9]*')
MS=$(echo "$RESULT" | grep '"duration_ms"' | head -1 | grep -o '[0-9]*')
echo "   Result: $COUNT callers found in ${MS}ms"
echo ""

# 6. DEAD CODE
echo "6. DEAD-CODE — Find unused exports in packages/excalidraw/actions/"
RESULT=$(node "$CLI" dead-code --scope packages/excalidraw/actions/ 2>/dev/null)
DEAD=$(echo "$RESULT" | grep '"total_dead"' | grep -o '[0-9]*')
MS=$(echo "$RESULT" | grep '"duration_ms"' | head -1 | grep -o '[0-9]*')
echo "   Result: $DEAD dead symbols found in ${MS}ms"
echo ""

echo "=========================================="
echo "  All operations: compiler-powered"
echo "  All output: structured JSON"
echo "  npm install -g codegraph-refactor"
echo "=========================================="
