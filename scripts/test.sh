#!/bin/bash
# Full test suite for codegraph
# Run from the codegraph root: ./scripts/test.sh

# No set -e: script tracks pass/fail manually via counters

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI="node $SCRIPT_DIR/../dist/cli.js"
FIXTURE="$SCRIPT_DIR/../test-fixture"
cd "$FIXTURE"

PASS=0
FAIL=0

assert_success() {
  local label="$1"
  local result="$2"
  local success=$(echo "$result" | grep -o '"success": true' | head -1)
  if [ -n "$success" ]; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label"
    echo "$result" | grep '"errors"' | head -3
    FAIL=$((FAIL + 1))
  fi
}

assert_fail() {
  local label="$1"
  local result="$2"
  local fail=$(echo "$result" | grep -o '"success": false' | head -1)
  if [ -n "$fail" ]; then
    echo "  PASS: $label (correctly refused)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label (should have refused)"
    FAIL=$((FAIL + 1))
  fi
}

assert_typecheck() {
  local label="$1"
  if npx tsc --noEmit 2>/dev/null; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label"
    FAIL=$((FAIL + 1))
  fi
}

echo "============================================"
echo "  codegraph test suite"
echo "  fixture: $FIXTURE"
echo "============================================"
echo ""

# Build first
echo "Building..."
cd "$SCRIPT_DIR/.."
npx tsc 2>&1
cd "$FIXTURE"
echo ""

# --- Query operations ---
echo "QUERY OPERATIONS:"

R=$($CLI refs --of User 2>/dev/null)
assert_success "refs --of User (16 refs expected)" "$R"
COUNT=$(echo "$R" | grep '"total_references"' | grep -o '[0-9]*')
[ "$COUNT" = "16" ] && echo "    refs count: $COUNT OK" || echo "    refs count: $COUNT EXPECTED 16"

R=$($CLI callers --of processOrder 2>/dev/null)
assert_success "callers --of processOrder" "$R"

R=$($CLI check-unused --symbol deprecatedUserCheck 2>/dev/null)
assert_success "check-unused (unused symbol)" "$R"
UNUSED=$(echo "$R" | grep '"is_unused": true')
[ -n "$UNUSED" ] && echo "    correctly identified as unused" || echo "    WRONG: should be unused"

R=$($CLI check-unused --symbol isAdmin 2>/dev/null)
assert_success "check-unused (used symbol)" "$R"
USED=$(echo "$R" | grep '"is_unused": false')
[ -n "$USED" ] && echo "    correctly identified as used" || echo "    WRONG: should be used"

R=$($CLI dead-code 2>/dev/null)
assert_success "dead-code" "$R"

R=$($CLI impact --of User 2>/dev/null)
assert_success "impact --of User" "$R"

echo ""
echo "MUTATE OPERATIONS:"

# --- Rename ---
R=$($CLI rename --symbol User --to Account --dry-run 2>/dev/null)
assert_success "rename --dry-run" "$R"

R=$($CLI rename --symbol User --to Account 2>/dev/null)
assert_success "rename User → Account" "$R"
assert_typecheck "type check after rename"

R=$($CLI undo 2>/dev/null)
assert_success "undo rename" "$R"
assert_typecheck "type check after undo rename"

# --- Add param ---
R=$($CLI add-param --function processOrder --name verbose --type boolean --default false 2>/dev/null)
assert_success "add-param processOrder" "$R"
assert_typecheck "type check after add-param"

R=$($CLI undo 2>/dev/null)
assert_success "undo add-param" "$R"
assert_typecheck "type check after undo add-param"

# --- Delete ---
R=$($CLI delete --symbol createUser 2>/dev/null)
assert_fail "delete in-use symbol (should refuse)" "$R"

R=$($CLI delete --symbol deprecatedUserCheck --dry-run 2>/dev/null)
assert_success "delete unused --dry-run" "$R"

R=$($CLI delete --symbol deprecatedUserCheck 2>/dev/null)
assert_success "delete unused symbol" "$R"
GONE=$(grep -c "deprecatedUserCheck" src/user-service.ts || true)
[ "$GONE" = "0" ] && echo "    symbol removed OK" || echo "    FAIL: symbol still present"

R=$($CLI undo 2>/dev/null)
assert_success "undo delete" "$R"
BACK=$(grep -c "deprecatedUserCheck" src/user-service.ts || true)
[ "$BACK" -gt "0" ] && echo "    symbol restored OK" || echo "    FAIL: symbol not restored"

# --- Move (dry-run only to avoid fixture changes) ---
R=$($CLI move --symbol isAdmin --to src/auth.ts --dry-run 2>/dev/null)
assert_success "move --dry-run" "$R"

echo ""
echo "OTHER:"

# --- Schema ---
TOOL_COUNT=$($CLI schema --format openai 2>/dev/null | grep '"name"' | wc -l | xargs)
echo "  schema: $TOOL_COUNT tool schemas generated"
[ "$TOOL_COUNT" -ge "10" ] && PASS=$((PASS + 1)) || FAIL=$((FAIL + 1))

# --- Help ---
HELP=$($CLI 2>/dev/null | head -1)
echo "  help: $HELP"
[ -n "$HELP" ] && PASS=$((PASS + 1)) || FAIL=$((FAIL + 1))

echo ""
echo "============================================"
echo "  RESULTS: $PASS passed, $FAIL failed"
echo "============================================"

exit $FAIL
