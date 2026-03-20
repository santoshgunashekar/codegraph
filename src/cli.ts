#!/usr/bin/env node

import path from "path";
import fs from "fs";
import { CodeGraphService } from "./service.js";
import { undoLast } from "./rollback.js";

function findTsConfig(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, "tsconfig.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function printUsage(): void {
  const usage = {
    success: false,
    operation: "help",
    duration_ms: 0,
    result: {
      commands: {
        "refs": {
          description: "Find all references to a symbol",
          usage: "codegraph refs --of <symbol>",
          example: "codegraph refs --of User",
        },
        "callers": {
          description: "Find all callers of a function",
          usage: "codegraph callers --of <symbol>",
          example: "codegraph callers --of processOrder",
        },
        "check-unused": {
          description: "Check if a symbol is unused",
          usage: "codegraph check-unused --symbol <name>",
          example: "codegraph check-unused --symbol formatLegacyDate",
        },
        "rename": {
          description: "Rename a symbol across the entire project",
          usage: "codegraph rename --symbol <old> --to <new> [--dry-run]",
          example: "codegraph rename --symbol User --to Account",
        },
      },
      symbol_formats: [
        "Name: --symbol User",
        "Qualified: --symbol UserService.create",
        "File:line: --symbol src/types.ts:14",
      ],
      flags: {
        "--project": "Path to tsconfig.json (auto-detected if omitted)",
        "--dry-run": "Preview changes without applying (rename only)",
        "--format": "Output format: json (default) or human",
      },
    },
    files_modified: [],
    warnings: [],
    errors: [{ code: "NO_COMMAND", message: "No command specified" }],
  };
  console.log(JSON.stringify(usage, null, 2));
}

function parseArgs(args: string[]): {
  command: string;
  symbol: string;
  to: string;
  project: string;
  scope: string;
  dryRun: boolean;
  format: string;
  name: string;
  type: string;
  default_value: string;
  position: number | undefined;
} {
  const result: ReturnType<typeof parseArgs> = {
    command: "",
    symbol: "",
    to: "",
    project: "",
    scope: "",
    dryRun: false,
    format: "json",
    name: "",
    type: "",
    default_value: "",
    position: undefined,
  };

  let i = 0;
  if (args.length > 0 && !args[0].startsWith("-")) {
    result.command = args[0];
    i = 1;
  }

  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "--of":
      case "--symbol":
      case "--function":
        result.symbol = args[++i] ?? "";
        break;
      case "--to":
        result.to = args[++i] ?? "";
        break;
      case "--project":
        result.project = args[++i] ?? "";
        break;
      case "--scope":
        result.scope = args[++i] ?? "";
        break;
      case "--dry-run":
        result.dryRun = true;
        break;
      case "--format":
        result.format = args[++i] ?? "json";
        break;
      case "--name":
        result.name = args[++i] ?? "";
        break;
      case "--type":
        result.type = args[++i] ?? "";
        break;
      case "--default":
        result.default_value = args[++i] ?? "";
        break;
      case "--position":
        result.position = parseInt(args[++i] ?? "", 10);
        break;
      default:
        // Ignore unknown flags
        break;
    }
    i++;
  }

  return result;
}

function formatHuman(result: Record<string, unknown>): string {
  const lines: string[] = [];

  const format = (obj: unknown, indent: number = 0): void => {
    const prefix = "  ".repeat(indent);
    if (Array.isArray(obj)) {
      for (const item of obj) {
        if (typeof item === "object" && item !== null) {
          const record = item as Record<string, unknown>;
          if ("file" in record && "line" in record) {
            const text = "text" in record ? ` — ${record.text}` : "";
            lines.push(`${prefix}  ${record.file}:${record.line}${text}`);
          } else {
            format(item, indent + 1);
          }
        } else {
          lines.push(`${prefix}  ${String(item)}`);
        }
      }
    } else if (typeof obj === "object" && obj !== null) {
      for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
        if (Array.isArray(val)) {
          lines.push(`${prefix}${key}:`);
          format(val, indent);
        } else if (typeof val === "object" && val !== null) {
          lines.push(`${prefix}${key}:`);
          format(val, indent + 1);
        } else {
          lines.push(`${prefix}${key}: ${String(val)}`);
        }
      }
    }
  };

  format(result);
  return lines.join("\n");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (!args.command) {
    printUsage();
    process.exit(1);
  }

  // Find tsconfig
  const tsconfigPath = args.project
    ? path.resolve(args.project)
    : findTsConfig(process.cwd());

  if (!tsconfigPath || !fs.existsSync(tsconfigPath)) {
    const error = {
      success: false,
      operation: args.command,
      duration_ms: 0,
      result: {},
      files_modified: [],
      warnings: [],
      errors: [{
        code: "NO_TSCONFIG",
        message: "No tsconfig.json found. Use --project to specify.",
      }],
    };
    console.log(JSON.stringify(error, null, 2));
    process.exit(1);
  }

  // Handle undo before initializing service (doesn't need compiler)
  if (args.command === "undo") {
    const projectRoot = path.dirname(tsconfigPath);
    const undoResult = undoLast(projectRoot);
    const output = {
      success: undoResult.success,
      operation: "undo",
      duration_ms: 0,
      result: undoResult.success ? {
        undone_operation: undoResult.operation,
        files_restored: undoResult.files_restored,
      } : {},
      files_modified: undoResult.files_restored,
      warnings: [],
      errors: undoResult.success ? [] : [{ code: "UNDO_FAILED", message: undoResult.error ?? "Unknown error" }],
    };
    console.log(JSON.stringify(output, null, 2));
    process.exit(undoResult.success ? 0 : 1);
  }

  // Initialize service
  const service = new CodeGraphService(tsconfigPath);

  let result;

  switch (args.command) {
    case "refs":
      if (!args.symbol) {
        console.log(JSON.stringify({
          success: false,
          operation: "refs",
          errors: [{ code: "MISSING_ARG", message: "Missing --of <symbol>" }],
        }, null, 2));
        process.exit(1);
      }
      result = service.findReferences(args.symbol);
      break;

    case "callers":
      if (!args.symbol) {
        console.log(JSON.stringify({
          success: false,
          operation: "callers",
          errors: [{ code: "MISSING_ARG", message: "Missing --of <symbol>" }],
        }, null, 2));
        process.exit(1);
      }
      result = service.findCallers(args.symbol);
      break;

    case "check-unused":
      if (!args.symbol) {
        console.log(JSON.stringify({
          success: false,
          operation: "check-unused",
          errors: [{ code: "MISSING_ARG", message: "Missing --symbol <name>" }],
        }, null, 2));
        process.exit(1);
      }
      result = service.checkUnused(args.symbol);
      break;

    case "rename":
      if (!args.symbol || !args.to) {
        console.log(JSON.stringify({
          success: false,
          operation: "rename",
          errors: [{ code: "MISSING_ARG", message: "Missing --symbol <old> --to <new>" }],
        }, null, 2));
        process.exit(1);
      }
      result = service.rename(args.symbol, args.to, args.dryRun);
      break;

    case "dead-code":
      result = service.deadCode(args.scope || undefined);
      break;

    case "impact":
      if (!args.symbol) {
        console.log(JSON.stringify({
          success: false,
          operation: "impact",
          errors: [{ code: "MISSING_ARG", message: "Missing --of <symbol>" }],
        }, null, 2));
        process.exit(1);
      }
      result = service.impact(args.symbol);
      break;

    case "move":
      if (!args.symbol || !args.to) {
        console.log(JSON.stringify({
          success: false,
          operation: "move",
          errors: [{ code: "MISSING_ARG", message: "Missing --symbol <name> --to <file>" }],
        }, null, 2));
        process.exit(1);
      }
      result = service.moveSymbol(args.symbol, args.to, args.dryRun);
      break;

    case "add-param":
      if (!args.symbol || !args.name || !args.type) {
        console.log(JSON.stringify({
          success: false,
          operation: "add-param",
          errors: [{ code: "MISSING_ARG", message: "Missing --function <name> --name <param> --type <type>" }],
        }, null, 2));
        process.exit(1);
      }
      result = service.addParam(
        args.symbol,
        args.name,
        args.type,
        args.default_value || undefined,
        args.position,
      );
      break;

    default:
      console.log(JSON.stringify({
        success: false,
        operation: args.command,
        errors: [{ code: "UNKNOWN_COMMAND", message: `Unknown command '${args.command}'. Run 'codegraph' for help.` }],
      }, null, 2));
      process.exit(1);
  }

  if (args.format === "human") {
    if (result.success) {
      console.log(formatHuman(result.result));
    } else {
      console.error(formatHuman({ errors: result.errors }));
    }
  } else {
    console.log(JSON.stringify(result, null, 2));
  }

  process.exit(result.success ? 0 : 1);
}

main();
