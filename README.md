# codegraph

**IDE refactoring, but for AI agents.**

Every structural operation the TypeScript compiler can do reliably — rename, move, find references, impact analysis — exposed as a CLI with JSON output that any AI agent can call.

```
Text-based rename of a type used in 124 files:
  Agent reads 124 files → generates 124 edits → retries failures
  ~280,000 tokens | 5-10 minutes | probable errors

codegraph rename --symbol ExcalidrawElement --to ExcalidrawNode:
  Compiler resolves every reference → applies atomically
  ~200 tokens | 591ms | zero errors
```

## The Problem

AI coding agents interact with code through tools designed for humans — text files, string-matching edits, unstructured CLI output. This creates measurable waste:

| Problem | Metric | Source |
|---------|--------|--------|
| Token waste on finding/reading code | 60-80% of budget | Tokenomics, MSR '26 |
| Text-based edit failure rate | 35% on first attempt | MorphLLM 2026 |
| Average attempts per successful edit | 2.3 | MorphLLM 2026 |
| Issues per AI-authored PR vs human | 1.7x more | CodeRabbit 2025 |
| Multi-file refactoring accuracy (text) | 55-60% | Faros AI 2026 |

The TypeScript compiler already knows every reference, every type, every call site. IDEs expose this to humans via GUI (F2 rename, Ctrl+Click go-to-definition). **No equivalent programmatic interface exists for agents.** CodeGraph is that interface.

## Install

```bash
npm install -g codegraph-refactor
```

Requires Node.js 18+. Works with any TypeScript or JavaScript project that has a `tsconfig.json`.

## Quick Start

```bash
# Navigate to any TypeScript project
cd my-project

# Find all references to a symbol
codegraph refs --of User

# Check what would break if you changed something
codegraph impact --of processOrder

# Rename across entire codebase (compiler-guaranteed correct)
codegraph rename --symbol User --to Account

# Preview changes without applying
codegraph rename --symbol User --to Account --dry-run

# Undo the last operation
codegraph undo

# Find dead code
codegraph dead-code --scope src/

# Add a parameter to a function, update all call sites
codegraph add-param --function createOrder --name priority --type string --default '"normal"'

# Move a function to another file, update all imports
codegraph move --symbol validateEmail --to src/validators/email.ts

# Check if something is safe to delete
codegraph check-unused --symbol deprecatedHelper
```

## Commands

### Query (read-only, no file changes)

| Command | What it does | What agents use it for |
|---------|-------------|----------------------|
| `codegraph refs --of <symbol>` | Find all references to a symbol | Orientation — understand usage before editing |
| `codegraph callers --of <symbol>` | Find all callers of a function | Know what breaks if you change a function |
| `codegraph check-unused --symbol <name>` | Check if a symbol has zero usages | Safe deletion — verify before removing |
| `codegraph dead-code [--scope <path>]` | Find all unused symbols in scope | Codebase cleanup without reading every file |
| `codegraph impact --of <symbol>` | Full blast radius analysis | Decide *whether* to change something before doing it |

### Mutate (modifies files)

| Command | What it does | Why agents can't do it via text |
|---------|-------------|-------------------------------|
| `codegraph rename --symbol <old> --to <new>` | Rename across all files | Text search can't distinguish type `User` from string `"User"` |
| `codegraph move --symbol <name> --to <file>` | Move symbol, update all imports | Must update the entire import/export graph atomically |
| `codegraph add-param --function <fn> --name <n> --type <t> [--default <v>]` | Add parameter, update all call sites | Must find every call site including indirect references |
| `codegraph undo` | Revert last mutation | — |

All mutate commands support `--dry-run` to preview changes without applying them.

## Output Format

All output is JSON — structured, parseable, no ANSI codes:

```json
{
  "success": true,
  "operation": "rename",
  "duration_ms": 45,
  "result": {
    "renamed": "User → Account",
    "total_locations": 16,
    "files_affected": 5,
    "file_changes": [
      { "file": "src/types.ts", "changes": 2 },
      { "file": "src/service.ts", "changes": 6 },
      { "file": "src/api.ts", "changes": 4 }
    ]
  },
  "files_modified": ["src/types.ts", "src/service.ts", "src/api.ts"],
  "warnings": [],
  "errors": []
}
```

Errors are structured, not prose:

```json
{
  "success": false,
  "operation": "rename",
  "errors": [{
    "code": "AMBIGUOUS_SYMBOL",
    "message": "Multiple symbols match 'User'. Use file:line to specify.",
  }],
  "result": {
    "candidates": [
      { "symbol": "User", "kind": "interface", "file": "src/types.ts", "line": 14 },
      { "symbol": "User", "kind": "class", "file": "src/models/user.ts", "line": 8 }
    ]
  }
}
```

## Symbol Resolution

Symbols can be specified three ways:

| Format | Example | When to use |
|--------|---------|-------------|
| By name | `--symbol User` | When the name is unambiguous |
| Qualified | `--symbol UserService.create` | Class.member disambiguation |
| By location | `--symbol src/types.ts:14` | Always unambiguous, for exact targeting |

When a name is ambiguous, CodeGraph returns all candidates with file/line info so the agent can pick the right one.

## Agent Integration

### Claude Code

Copy the included `CLAUDE.md` to your project root:

```bash
cp node_modules/codegraph-refactor/CLAUDE.md ./CLAUDE.md
```

Claude Code will automatically use `codegraph` for structural operations — rename, move, find references — instead of text-based edits.

### Cursor

Add to `.cursor/rules`:

```
For renaming, moving, or finding references to code symbols, use the `codegraph` CLI
instead of text-based edits. It uses the TypeScript compiler for guaranteed-correct results.

Available commands:
- codegraph refs --of <symbol>         (find all references)
- codegraph callers --of <symbol>      (find callers)
- codegraph check-unused --symbol <n>  (check if unused)
- codegraph dead-code --scope <path>   (find dead code)
- codegraph impact --of <symbol>       (blast radius)
- codegraph rename --symbol <old> --to <new> [--dry-run]
- codegraph move --symbol <name> --to <file> [--dry-run]
- codegraph add-param --function <fn> --name <n> --type <t> [--default <v>]
- codegraph undo                       (revert last change)
```

### Any Agent

CodeGraph works with any agent that can run shell commands and parse JSON. Add to your system prompt:

> For structural code operations (rename, move, find references, impact analysis), use the `codegraph` CLI instead of text-based edits. It wraps the TypeScript compiler for guaranteed-correct cross-file refactoring. All output is JSON. Run `codegraph` with no arguments to see all commands.

### MCP / Tool Schema

Get the full tool schema for function-calling APIs:

```bash
codegraph  # prints all commands with usage
```

## Performance

Benchmarked on [Excalidraw](https://github.com/excalidraw/excalidraw) (589 TypeScript files):

| Operation | Time | Details |
|-----------|------|---------|
| Cold start (index) | 4.6s | 589 files parsed and type-checked |
| Find references | 1.08s | 851 references to `ExcalidrawElement` |
| Impact analysis | 1.01s | 850 refs, 124 files, export surface detected |
| Rename (dry-run) | 0.59s | 851 locations across 124 files |
| Check unused | 0.84s | Full reference search, zero/non-zero answer |

### Token Comparison

| Operation | Agent via text edits | CodeGraph | Savings |
|-----------|---------------------|-----------|---------|
| "What calls processOrder?" | Read 10+ files (~12,000 tokens) | `codegraph callers --of processOrder` (~200 tokens) | 60x |
| Rename type across 5 files | Read + edit + retry (~23,000 tokens) | `codegraph rename` (~150 tokens) | 150x |
| "Is this safe to delete?" | Read entire codebase (impossible) | `codegraph check-unused` (~150 tokens) | Infinite (enables new capability) |
| Rename across 124 files | ~280,000 tokens, 5-10 min | `codegraph rename` (~200 tokens, 591ms) | 1,400x |

## How It Works

```
┌──────────────────────────────────────────────────┐
│                 Agent / User                      │
│            (shell command + JSON)                  │
└─────────────────────┬────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────────┐
│                CodeGraph CLI                      │
│                                                  │
│  ┌─────────────────────────────────────────────┐ │
│  │           Operation Engine                   │ │
│  │  refs · callers · rename · move · impact    │ │
│  │  dead-code · check-unused · add-param       │ │
│  └──────────────────┬──────────────────────────┘ │
│                     │                            │
│  ┌──────────────────┴──────────────────────────┐ │
│  │     TypeScript LanguageService API          │ │
│  │  (same engine as VS Code's F2 rename)       │ │
│  └─────────────────────────────────────────────┘ │
│                                                  │
│  ┌─────────────────────────────────────────────┐ │
│  │  Rollback Journal (.codegraph/rollback.json)│ │
│  │  Atomic writes · Undo support               │ │
│  └─────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────┘
                      │
                      ▼
               ┌──────────────┐
               │  Source Code  │
               │  (text files  │
               │   remain the  │
               │   source of   │
               │   truth)      │
               └──────────────┘
```

CodeGraph wraps the TypeScript `LanguageService` API — the same engine that powers VS Code's "Rename Symbol" (F2), "Find All References", and "Go to Definition". It creates a programmatic interface so agents can use these operations without a GUI.

- **Text files remain the source of truth.** No database, no daemon, no lock-in.
- **Auto-detects `tsconfig.json`** in the current or parent directory.
- **Atomic operations** — all files updated together or none at all.
- **Rollback journal** — every mutation is reversible via `codegraph undo`.

## Supported Languages

| Language | Status | Notes |
|----------|--------|-------|
| TypeScript | Supported | Full support via TypeScript compiler API |
| JavaScript | Supported | Via TypeScript compiler in JS mode |
| TSX/JSX | Supported | Included with TypeScript/JavaScript |
| Python | Planned | Via pyright (Phase 2) |
| Go | Planned | Via go/analysis (Phase 3) |

## Examples

### Find all references before making a change

```bash
$ codegraph refs --of UserRole
{
  "success": true,
  "operation": "refs",
  "duration_ms": 34,
  "result": {
    "symbol": "UserRole",
    "kind": "enum",
    "defined_in": "src/types.ts:8",
    "total_references": 12,
    "references": [
      { "file": "src/types.ts", "line": 8, "text": "export enum UserRole {", "is_definition": true },
      { "file": "src/types.ts", "line": 5, "text": "role: UserRole;", "is_definition": false },
      { "file": "src/service.ts", "line": 1, "text": "import { User, UserRole } from \"./types.js\";", "is_definition": false },
      ...
    ]
  }
}
```

### Impact analysis before a risky change

```bash
$ codegraph impact --of ExcalidrawElement
{
  "success": true,
  "operation": "impact",
  "duration_ms": 1014,
  "result": {
    "symbol": "ExcalidrawElement",
    "kind": "type_alias",
    "defined_in": "packages/element/src/types.ts:206",
    "is_exported": true,
    "direct_references": 850,
    "files_affected": 124,
    "test_files_affected": 12,
    "risk_level": "high",
    "export_surfaces": [
      { "file": "packages/excalidraw/index.tsx", "line": 45, "surface": "re-export" }
    ]
  },
  "warnings": [{
    "code": "EXPORTED_SYMBOL",
    "message": "ExcalidrawElement is exported. External consumers may break."
  }]
}
```

### Find dead code across the project

```bash
$ codegraph dead-code --scope src/
{
  "success": true,
  "operation": "dead-code",
  "duration_ms": 218,
  "result": {
    "scope": "src/",
    "total_dead": 3,
    "dead_symbols": [
      { "symbol": "deprecatedUserCheck", "kind": "function", "file": "src/utils.ts", "line": 29 },
      { "symbol": "OldUserSchema", "kind": "type_alias", "file": "src/types.ts", "line": 145 },
      { "symbol": "retryCount", "kind": "variable", "file": "src/config.ts", "line": 8 }
    ]
  }
}
```

### Add a parameter and update all callers

```bash
$ codegraph add-param --function createOrder --name priority --type string --default '"normal"'
{
  "success": true,
  "operation": "add-param",
  "duration_ms": 77,
  "result": {
    "function": "createOrder",
    "parameter_added": { "name": "priority", "type": "string", "position": 2, "default": "\"normal\"" },
    "call_sites_updated": 1,
    "files_modified": 2,
    "call_sites": [
      { "file": "src/api.ts", "line": 13 }
    ]
  }
}
```

### Dry-run a rename to preview changes

```bash
$ codegraph rename --symbol User --to Account --dry-run
{
  "success": true,
  "operation": "rename",
  "duration_ms": 38,
  "result": {
    "renamed": "User → Account",
    "total_locations": 16,
    "files_affected": 5,
    "dry_run": true,
    "file_changes": [
      { "file": "src/types.ts", "changes": 2 },
      { "file": "src/user-service.ts", "changes": 6 },
      { "file": "src/order-service.ts", "changes": 3 },
      { "file": "src/api.ts", "changes": 4 },
      { "file": "src/index.ts", "changes": 1 }
    ]
  }
}

# Looks good — apply it
$ codegraph rename --symbol User --to Account

# Changed your mind?
$ codegraph undo
```

## Contributing

CodeGraph is MIT licensed. Contributions welcome.

```bash
git clone https://github.com/santoshgunashekar/codegraph.git
cd codegraph
npm install
npm run build

# Test against the included fixture
cd test-fixture
node ../dist/cli.js refs --of User
node ../dist/cli.js rename --symbol User --to Account --dry-run
```

### Architecture

```
src/
├── cli.ts        # CLI argument parsing, command routing, output formatting
├── service.ts    # Core engine — wraps ts.LanguageService for all operations
└── rollback.ts   # Undo system — saves file state before mutations
```

Each operation is a method on `CodeGraphService`. To add a new operation:

1. Add the method to `src/service.ts`
2. Add the command case to the switch in `src/cli.ts`
3. Test against `test-fixture/`

## License

MIT
