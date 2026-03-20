#!/bin/bash
# Run this in the LEFT terminal — shows what agents do today
cd /tmp/excalidraw

echo "=========================================="
echo "  TEXT-BASED AGENT — same 6 tasks"
echo "  Excalidraw: 589 TypeScript files"
echo "=========================================="
echo ""

# 1. RENAME
echo "1. RENAME — ExcalidrawElement -> ExcalidrawNode"
FILE_COUNT=$(grep -rl 'ExcalidrawElement' --include='*.ts' --include='*.tsx' | wc -l | xargs)
OCC_COUNT=$(grep -r 'ExcalidrawElement' --include='*.ts' --include='*.tsx' | wc -l | xargs)
echo "   grep finds: $FILE_COUNT files, $OCC_COUNT occurrences"
echo "   But grep also matches:"
echo "     ExcalidrawElements (plural)"
echo "     ExcalidrawElementSkeleton (partial match)"
echo "     strings and comments (false positives)"
echo "   Agent: read $FILE_COUNT files, generate edits, retry 35%"
echo "   Cost: ~280,000 tokens | 5-10 min"
echo ""

# 2. IMPACT ANALYSIS
echo "2. IMPACT — What breaks if I change ExcalidrawElement?"
echo "   Agent: must read EVERY file to answer this"
echo "   Cannot know export surfaces without reading all imports"
echo "   Cannot assess risk without full dependency graph"
echo "   Cost: ~150,000 tokens | impossible to be exhaustive"
echo ""

# 3. FIND REFERENCES
echo "3. REFS — Where is ExcalidrawElement used?"
echo "   Agent: grep -r 'ExcalidrawElement' ..."
GREP_HITS=$(grep -r 'ExcalidrawElement' --include='*.ts' --include='*.tsx' | wc -l | xargs)
echo "   grep returns: $GREP_HITS lines (includes false positives)"
echo "   Agent must read each file to verify"
echo "   Cost: ~120,000 tokens"
echo ""

# 4. CHECK UNUSED
echo "4. CHECK-UNUSED — Is actionDeleteSelected safe to delete?"
echo "   Agent: must read ENTIRE codebase to prove nothing uses it"
echo "   589 files = ~500,000 tokens just to read everything"
echo "   Cost: ~500,000 tokens | often skipped (too expensive)"
echo ""

# 5. CALLERS
echo "5. CALLERS — Who calls newElementWith?"
echo "   Agent: grep -r 'newElementWith(' ..."
GREP_CALLERS=$(grep -r 'newElementWith(' --include='*.ts' --include='*.tsx' | wc -l | xargs)
echo "   grep returns: $GREP_CALLERS hits (includes imports, not just calls)"
echo "   Agent must read context to distinguish calls from imports"
echo "   Cost: ~40,000 tokens"
echo ""

# 6. DEAD CODE
echo "6. DEAD-CODE — Find unused exports"
echo "   Agent: must cross-reference every export against every import"
echo "   Requires reading every file in the project"
echo "   Cost: ~500,000+ tokens | practically impossible"
echo ""

echo "=========================================="
echo "  Total: ~1,570,000 tokens for 6 tasks"
echo "  Time: 15-30 minutes"
echo "  Accuracy: best-effort, errors likely"
echo "=========================================="
