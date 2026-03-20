#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
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

function formatResult(result: unknown): string {
  return JSON.stringify(result, null, 2);
}

async function main(): Promise<void> {
  const projectDir = process.env.CODEGRAPH_PROJECT || process.cwd();
  const tsconfigPath = process.env.CODEGRAPH_TSCONFIG || findTsConfig(projectDir);

  if (!tsconfigPath || !fs.existsSync(tsconfigPath)) {
    console.error("codegraph-mcp: No tsconfig.json found. Set CODEGRAPH_PROJECT or CODEGRAPH_TSCONFIG.");
    process.exit(1);
  }

  const projectRoot = path.dirname(tsconfigPath);
  let service = new CodeGraphService(tsconfigPath);

  const reinit = () => {
    service = new CodeGraphService(tsconfigPath);
  };

  const server = new McpServer({
    name: "codegraph",
    version: "0.2.0",
  });

  // --- Query tools ---

  server.registerTool(
    "codegraph_refs",
    {
      description: "Find all references to a symbol across the codebase. Returns every file and line where the symbol is used, imported, or re-exported.",
      inputSchema: {
        symbol: z.string().describe("Symbol to find references for. Formats: name ('User'), qualified ('Service.method'), or file:line ('src/types.ts:14')"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ symbol }) => {
      const result = service.findReferences(symbol);
      return { content: [{ type: "text" as const, text: formatResult(result) }] };
    }
  );

  server.registerTool(
    "codegraph_callers",
    {
      description: "Find all callers of a function. Returns only call sites (excludes imports, type annotations, and the definition).",
      inputSchema: {
        symbol: z.string().describe("Function name to find callers of"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ symbol }) => {
      const result = service.findCallers(symbol);
      return { content: [{ type: "text" as const, text: formatResult(result) }] };
    }
  );

  server.registerTool(
    "codegraph_check_unused",
    {
      description: "Check if a symbol has zero usages (safe to delete). Returns is_unused: true/false and the usage count.",
      inputSchema: {
        symbol: z.string().describe("Symbol to check"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ symbol }) => {
      const result = service.checkUnused(symbol);
      return { content: [{ type: "text" as const, text: formatResult(result) }] };
    }
  );

  server.registerTool(
    "codegraph_dead_code",
    {
      description: "Find all unused/dead symbols in a directory. Scans every exported and top-level symbol and reports those with zero references.",
      inputSchema: {
        scope: z.string().optional().describe("Directory to scan (e.g. 'src/'). Omit to scan entire project."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ scope }) => {
      const result = service.deadCode(scope);
      return { content: [{ type: "text" as const, text: formatResult(result) }] };
    }
  );

  server.registerTool(
    "codegraph_impact",
    {
      description: "Analyze the blast radius of changing a symbol BEFORE making the change. Returns reference count, affected files, test files, export surfaces, and risk level.",
      inputSchema: {
        symbol: z.string().describe("Symbol to analyze impact for"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ symbol }) => {
      const result = service.impact(symbol);
      return { content: [{ type: "text" as const, text: formatResult(result) }] };
    }
  );

  // --- Mutate tools ---

  server.registerTool(
    "codegraph_rename",
    {
      description: "Rename a symbol across the entire codebase using the TypeScript compiler. Guaranteed correct — finds references by type resolution, not string matching. Updates all files atomically.",
      inputSchema: {
        symbol: z.string().describe("Symbol to rename"),
        to: z.string().describe("New name"),
        dry_run: z.boolean().optional().default(false).describe("Preview changes without applying"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ symbol, to, dry_run }) => {
      const result = service.rename(symbol, to, dry_run);
      if (!dry_run && result.success) reinit();
      return { content: [{ type: "text" as const, text: formatResult(result) }] };
    }
  );

  server.registerTool(
    "codegraph_move",
    {
      description: "Move a symbol (function, class, constant) to another file. Updates all imports and re-exports across the codebase.",
      inputSchema: {
        symbol: z.string().describe("Symbol to move"),
        to: z.string().describe("Target file path (relative to project root)"),
        dry_run: z.boolean().optional().default(false).describe("Preview changes without applying"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ symbol, to, dry_run }) => {
      const result = service.moveSymbol(symbol, to, dry_run);
      if (!dry_run && result.success) reinit();
      return { content: [{ type: "text" as const, text: formatResult(result) }] };
    }
  );

  server.registerTool(
    "codegraph_add_param",
    {
      description: "Add a parameter to a function and update all call sites. The compiler finds every caller and adds the default value.",
      inputSchema: {
        function_name: z.string().describe("Function name to add parameter to"),
        name: z.string().describe("Parameter name"),
        type: z.string().describe("Parameter type (e.g. 'string', 'number')"),
        default_value: z.string().optional().describe("Default value. If provided, call sites get this value."),
        position: z.number().optional().describe("Position to insert at (0-indexed). Omit to add at end."),
      },
      annotations: { destructiveHint: true },
    },
    async ({ function_name, name, type, default_value, position }) => {
      const result = service.addParam(function_name, name, type, default_value, position);
      if (result.success) reinit();
      return { content: [{ type: "text" as const, text: formatResult(result) }] };
    }
  );

  server.registerTool(
    "codegraph_delete",
    {
      description: "Delete an unused symbol and clean up its imports/exports from all files. Refuses to delete if the symbol is still in use.",
      inputSchema: {
        symbol: z.string().describe("Symbol to delete"),
        dry_run: z.boolean().optional().default(false).describe("Preview changes without applying"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ symbol, dry_run }) => {
      const result = service.deleteSymbol(symbol, dry_run);
      if (!dry_run && result.success) reinit();
      return { content: [{ type: "text" as const, text: formatResult(result) }] };
    }
  );

  server.registerTool(
    "codegraph_undo",
    {
      description: "Undo the last codegraph mutation (rename, move, add-param, delete). Restores all modified files to their previous state.",
      inputSchema: {},
      annotations: { destructiveHint: true },
    },
    async () => {
      const result = undoLast(projectRoot);
      const output = {
        success: result.success,
        operation: "undo",
        duration_ms: 0,
        result: result.success ? {
          undone_operation: result.operation,
          files_restored: result.files_restored,
        } : {},
        files_modified: result.files_restored,
        warnings: [],
        errors: result.success ? [] : [{ code: "UNDO_FAILED", message: result.error ?? "Unknown error" }],
      };
      if (result.success) reinit();
      return { content: [{ type: "text" as const, text: formatResult(output) }] };
    }
  );

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`codegraph-mcp: connected (project: ${projectRoot}, ${service ? "ready" : "error"})`);
}

main().catch((error) => {
  console.error("codegraph-mcp: fatal error:", error);
  process.exit(1);
});
