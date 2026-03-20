#!/usr/bin/env node

import path from "path";
import fs from "fs";
import { CodeGraphService } from "./service.js";
import { undoLast } from "./rollback.js";
import { getSchema } from "./schema.js";
import { startWatchServer, sendToWatch } from "./watch.js";

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

function outputResult(result: { success: boolean; result: Record<string, unknown>; errors: Array<{ code: string; message: string }> }, format: string): void {
  if (format === "human") {
    if (result.success) {
      console.log(formatHuman(result.result));
    } else {
      console.error(formatHuman({ errors: result.errors }));
    }
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // --- Commands that don't need tsconfig ---

  if (!args.command) {
    console.log(getSchema("commands"));
    process.exit(0);
  }

  if (args.command === "schema") {
    console.log(getSchema(args.format || "openai"));
    process.exit(0);
  }

  // --- Find tsconfig ---

  const tsconfigPath = args.project
    ? path.resolve(args.project)
    : findTsConfig(process.cwd());

  if (!tsconfigPath || !fs.existsSync(tsconfigPath)) {
    console.log(JSON.stringify({
      success: false,
      operation: args.command,
      duration_ms: 0,
      result: {},
      files_modified: [],
      warnings: [],
      errors: [{ code: "NO_TSCONFIG", message: "No tsconfig.json found. Use --project to specify." }],
    }, null, 2));
    process.exit(1);
  }

  const projectRoot = path.dirname(tsconfigPath);

  // --- Commands that don't need the compiler ---

  if (args.command === "undo") {
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

  if (args.command === "watch") {
    startWatchServer(tsconfigPath);
    return; // watch runs forever
  }

  // --- Try watch server first (skip cold start) ---

  const watchArgs = buildWatchArgs(args);
  if (watchArgs) {
    const watchResult = await sendToWatch(projectRoot, args.command, watchArgs);
    if (watchResult) {
      // Got result from watch server
      const parsed = JSON.parse(watchResult);
      outputResult(parsed, args.format);
      process.exit(parsed.success ? 0 : 1);
    }
    // No watch server running — fall through to direct execution
  }

  // --- Direct execution (cold start) ---

  const service = new CodeGraphService(tsconfigPath);
  let result;

  switch (args.command) {
    case "refs":
      if (!args.symbol) { exitMissingArg("refs", "--of <symbol>"); return; }
      result = service.findReferences(args.symbol);
      break;

    case "callers":
      if (!args.symbol) { exitMissingArg("callers", "--of <symbol>"); return; }
      result = service.findCallers(args.symbol);
      break;

    case "check-unused":
      if (!args.symbol) { exitMissingArg("check-unused", "--symbol <name>"); return; }
      result = service.checkUnused(args.symbol);
      break;

    case "rename":
      if (!args.symbol || !args.to) { exitMissingArg("rename", "--symbol <old> --to <new>"); return; }
      result = service.rename(args.symbol, args.to, args.dryRun);
      break;

    case "dead-code":
      result = service.deadCode(args.scope || undefined);
      break;

    case "impact":
      if (!args.symbol) { exitMissingArg("impact", "--of <symbol>"); return; }
      result = service.impact(args.symbol);
      break;

    case "move":
      if (!args.symbol || !args.to) { exitMissingArg("move", "--symbol <name> --to <file>"); return; }
      result = service.moveSymbol(args.symbol, args.to, args.dryRun);
      break;

    case "add-param":
      if (!args.symbol || !args.name || !args.type) { exitMissingArg("add-param", "--function <name> --name <param> --type <type>"); return; }
      result = service.addParam(args.symbol, args.name, args.type, args.default_value || undefined, args.position);
      break;

    case "delete":
      if (!args.symbol) { exitMissingArg("delete", "--symbol <name>"); return; }
      result = service.deleteSymbol(args.symbol, args.dryRun);
      break;

    default:
      console.log(JSON.stringify({
        success: false,
        operation: args.command,
        errors: [{ code: "UNKNOWN_COMMAND", message: `Unknown command '${args.command}'. Run 'codegraph' for help.` }],
      }, null, 2));
      process.exit(1);
  }

  outputResult(result, args.format);
  process.exit(result.success ? 0 : 1);
}

function buildWatchArgs(args: ReturnType<typeof parseArgs>): Record<string, unknown> | null {
  switch (args.command) {
    case "refs":
    case "callers":
    case "check-unused":
    case "impact":
      return args.symbol ? { symbol: args.symbol } : null;
    case "rename":
      return args.symbol && args.to ? { symbol: args.symbol, to: args.to, dryRun: args.dryRun } : null;
    case "move":
      return args.symbol && args.to ? { symbol: args.symbol, to: args.to, dryRun: args.dryRun } : null;
    case "dead-code":
      return { scope: args.scope || undefined };
    case "add-param":
      return args.symbol && args.name && args.type ? {
        symbol: args.symbol, name: args.name, type: args.type,
        default: args.default_value || undefined, position: args.position,
      } : null;
    case "delete":
      return args.symbol ? { symbol: args.symbol, dryRun: args.dryRun } : null;
    default:
      return null;
  }
}

function exitMissingArg(operation: string, missing: string): void {
  console.log(JSON.stringify({
    success: false,
    operation,
    errors: [{ code: "MISSING_ARG", message: `Missing ${missing}` }],
  }, null, 2));
  process.exit(1);
}

main();
