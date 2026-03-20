# CodeGraph

This project has `codegraph` installed. Use it instead of text-based edits for structural code operations. CodeGraph wraps the TypeScript compiler to perform guaranteed-correct refactoring via CLI.

## When to use CodeGraph

Use `codegraph` for any operation that involves finding or modifying symbols across files:
- Renaming functions, types, classes, variables
- Moving symbols between files
- Adding/removing function parameters
- Finding references, callers, or unused code
- Understanding impact before making changes

Use regular text edits for: writing new code, changing logic inside functions, modifying comments/strings.

## Commands

### Query (read-only, no file changes)

```bash
# Find all references to a symbol
codegraph refs --of <symbol>

# Find all callers of a function
codegraph callers --of <symbol>

# Check if a symbol is unused (safe to delete)
codegraph check-unused --symbol <symbol>

# Find all dead/unused code in a directory
codegraph dead-code [--scope <path>]

# Analyze blast radius before making a change
codegraph impact --of <symbol>
```

### Mutate (modifies files, supports --undo)

```bash
# Rename a symbol across the entire codebase
codegraph rename --symbol <old> --to <new> [--dry-run]

# Move a symbol to another file, update all imports
codegraph move --symbol <name> --to <file> [--dry-run]

# Add a parameter to a function, update all call sites
codegraph add-param --function <name> --name <param> --type <type> [--default <value>]

# Undo the last mutate operation
codegraph undo
```

## Symbol formats

- By name: `--symbol User`
- Qualified: `--symbol UserService.create`
- By location: `--symbol src/types.ts:14`

## Important notes

- All output is JSON. Parse it to get structured results.
- Use `--dry-run` on rename/move to preview changes before applying.
- Use `codegraph undo` to revert the last operation if something went wrong.
- Always prefer `codegraph` over text-based find-and-replace for renames and moves. It uses the TypeScript compiler to find every reference by type resolution, not string matching.
- `codegraph impact --of <symbol>` before changing a widely-used type or function. It tells you how many files are affected and whether the symbol is part of the public API.
