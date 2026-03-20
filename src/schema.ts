/**
 * Machine-readable tool schemas for agent integration.
 * Supports OpenAI function-calling format and generic JSON Schema.
 */

interface ToolParam {
  type: string;
  description: string;
  enum?: string[];
  default?: unknown;
}

interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, ToolParam>;
    required: string[];
  };
}

const tools: ToolSchema[] = [
  {
    name: "codegraph_refs",
    description: "Find all references to a symbol across the codebase. Returns every file and line where the symbol is used, imported, or re-exported. Use this to understand how widely a symbol is used before making changes.",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Symbol to find references for. Formats: name ('User'), qualified ('Service.method'), or file:line ('src/types.ts:14')" },
      },
      required: ["symbol"],
    },
  },
  {
    name: "codegraph_callers",
    description: "Find all callers of a function. Like refs but filtered to only call sites (excludes imports, type annotations, and the definition itself).",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Function name to find callers of" },
      },
      required: ["symbol"],
    },
  },
  {
    name: "codegraph_check_unused",
    description: "Check if a symbol has zero usages (safe to delete). Returns is_unused: true/false and the usage count.",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Symbol to check" },
      },
      required: ["symbol"],
    },
  },
  {
    name: "codegraph_dead_code",
    description: "Find all unused/dead symbols in a directory. Scans every exported and top-level symbol and reports those with zero references.",
    parameters: {
      type: "object",
      properties: {
        scope: { type: "string", description: "Directory to scan (e.g. 'src/'). Omit to scan entire project." },
      },
      required: [],
    },
  },
  {
    name: "codegraph_impact",
    description: "Analyze the blast radius of changing a symbol BEFORE making the change. Returns reference count, affected files, test files, export surfaces, and risk level. Use this to decide whether and how to change something.",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Symbol to analyze impact for" },
      },
      required: ["symbol"],
    },
  },
  {
    name: "codegraph_rename",
    description: "Rename a symbol across the entire codebase using the TypeScript compiler. Guaranteed correct — finds references by type resolution, not string matching. Updates all files atomically. Supports --dry-run and --undo.",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Symbol to rename" },
        to: { type: "string", description: "New name" },
        dry_run: { type: "boolean", description: "Preview changes without applying", default: false },
      },
      required: ["symbol", "to"],
    },
  },
  {
    name: "codegraph_move",
    description: "Move a symbol (function, class, constant) to another file. Updates all imports and re-exports across the codebase. Detects circular dependencies.",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Symbol to move" },
        to: { type: "string", description: "Target file path (relative to project root)" },
        dry_run: { type: "boolean", description: "Preview changes without applying", default: false },
      },
      required: ["symbol", "to"],
    },
  },
  {
    name: "codegraph_add_param",
    description: "Add a parameter to a function and update all call sites. The compiler finds every caller (including indirect references) and adds the default value.",
    parameters: {
      type: "object",
      properties: {
        function: { type: "string", description: "Function name to add parameter to" },
        name: { type: "string", description: "Parameter name" },
        type: { type: "string", description: "Parameter type (e.g. 'string', 'number', 'Priority')" },
        default: { type: "string", description: "Default value (e.g. '\"normal\"', '0', 'Priority.LOW'). If provided, call sites get this value." },
        position: { type: "number", description: "Position to insert at (0-indexed). Omit to add at end." },
      },
      required: ["function", "name", "type"],
    },
  },
  {
    name: "codegraph_delete",
    description: "Delete an unused symbol and clean up its imports/exports from all files. Refuses to delete if the symbol is still in use (run check-unused first).",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Symbol to delete" },
        dry_run: { type: "boolean", description: "Preview changes without applying", default: false },
      },
      required: ["symbol"],
    },
  },
  {
    name: "codegraph_undo",
    description: "Undo the last codegraph mutation (rename, move, add-param, delete). Restores all modified files to their previous state.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

export function getSchema(format: string = "openai"): string {
  if (format === "openai") {
    const openaiTools = tools.map(t => ({
      type: "function" as const,
      function: t,
    }));
    return JSON.stringify(openaiTools, null, 2);
  }

  if (format === "anthropic") {
    const anthropicTools = tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
    return JSON.stringify(anthropicTools, null, 2);
  }

  if (format === "commands") {
    // Human-readable CLI reference
    const lines: string[] = [
      "codegraph - IDE refactoring, but for AI agents\n",
      "QUERY COMMANDS (read-only):\n",
      "  codegraph refs --of <symbol>              Find all references",
      "  codegraph callers --of <symbol>           Find all callers of a function",
      "  codegraph check-unused --symbol <name>    Check if symbol is unused",
      "  codegraph dead-code [--scope <path>]      Find all dead code",
      "  codegraph impact --of <symbol>            Blast radius analysis",
      "",
      "MUTATE COMMANDS:\n",
      "  codegraph rename --symbol <old> --to <new> [--dry-run]",
      "  codegraph move --symbol <name> --to <file> [--dry-run]",
      "  codegraph add-param --function <fn> --name <n> --type <t> [--default <v>]",
      "  codegraph delete --symbol <name> [--dry-run]",
      "  codegraph undo",
      "",
      "OTHER:\n",
      "  codegraph schema [--format openai|anthropic|commands]",
      "  codegraph watch                           Start watch mode (persistent server)",
      "",
      "SYMBOL FORMATS:",
      "  Name:      --symbol User",
      "  Qualified: --symbol Service.method",
      "  Location:  --symbol src/types.ts:14",
      "",
      "FLAGS:",
      "  --project <path>   Path to tsconfig.json (auto-detected)",
      "  --dry-run           Preview changes without applying",
      "  --format json|human Output format (default: json)",
    ];
    return lines.join("\n");
  }

  // Default: raw JSON Schema array
  return JSON.stringify(tools, null, 2);
}
