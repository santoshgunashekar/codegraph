#!/usr/bin/env node

import fs from "fs";
import path from "path";
import net from "net";
import readline from "readline";
import { CodeGraphService } from "./service.js";

const SOCKET_PATH_PREFIX = "/tmp/codegraph-";

function getSocketPath(projectRoot: string): string {
  // Create a stable socket name from the project root
  const hash = Buffer.from(projectRoot).toString("base64url").substring(0, 16);
  return `${SOCKET_PATH_PREFIX}${hash}.sock`;
}

export function startWatchServer(tsconfigPath: string): void {
  const projectRoot = path.dirname(tsconfigPath);
  const socketPath = getSocketPath(projectRoot);

  // Clean up stale socket
  if (fs.existsSync(socketPath)) {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // ignore
    }
  }

  let service = new CodeGraphService(tsconfigPath);

  // Watch for file changes and invalidate
  const watcher = fs.watch(projectRoot, { recursive: true }, (eventType, filename) => {
    if (!filename) return;
    if (filename.endsWith(".ts") || filename.endsWith(".tsx") || filename.endsWith(".js") || filename.endsWith(".jsx")) {
      if (filename.includes("node_modules") || filename.includes("dist") || filename.includes(".codegraph")) return;
      // Re-initialize the service to pick up changes
      try {
        service = new CodeGraphService(tsconfigPath);
      } catch (e) {
        process.stderr.write(`CodeGraph watch: re-index failed: ${e}\n`);
      }
    }
  });

  const server = net.createServer((socket) => {
    const rl = readline.createInterface({ input: socket });

    rl.on("line", (line) => {
      try {
        const request = JSON.parse(line);
        const { command, args } = request;

        let result;
        const startTime = Date.now();

        switch (command) {
          case "refs":
            result = service.findReferences(args.symbol);
            break;
          case "callers":
            result = service.findCallers(args.symbol);
            break;
          case "check-unused":
            result = service.checkUnused(args.symbol);
            break;
          case "rename":
            result = service.rename(args.symbol, args.to, args.dryRun ?? false);
            if (!args.dryRun) {
              // Re-index after mutation
              service = new CodeGraphService(tsconfigPath);
            }
            break;
          case "dead-code":
            result = service.deadCode(args.scope);
            break;
          case "impact":
            result = service.impact(args.symbol);
            break;
          case "move":
            result = service.moveSymbol(args.symbol, args.to, args.dryRun ?? false);
            if (!args.dryRun) {
              service = new CodeGraphService(tsconfigPath);
            }
            break;
          case "add-param":
            result = service.addParam(args.symbol, args.name, args.type, args.default, args.position);
            service = new CodeGraphService(tsconfigPath);
            break;
          case "delete":
            result = service.deleteSymbol(args.symbol, args.dryRun ?? false);
            if (!args.dryRun) {
              service = new CodeGraphService(tsconfigPath);
            }
            break;
          case "type-check":
            result = service.typeCheck(args.scope);
            break;
          case "deps":
            result = service.deps(args.symbol);
            break;
          case "exports":
            result = service.exports(args.module);
            break;
          case "signature":
            result = service.signature(args.symbol);
            break;
          case "extract-function":
            result = service.extractFunction(args.source, args.startLine, args.endLine, args.name);
            if (result.success) {
              service = new CodeGraphService(tsconfigPath);
            }
            break;
          case "ping":
            result = {
              success: true,
              operation: "ping",
              duration_ms: 0,
              result: { status: "alive", project: projectRoot },
              files_modified: [],
              warnings: [],
              errors: [],
            };
            break;
          default:
            result = {
              success: false,
              operation: command,
              duration_ms: 0,
              result: {},
              files_modified: [],
              warnings: [],
              errors: [{ code: "UNKNOWN_COMMAND", message: `Unknown command: ${command}` }],
            };
        }

        socket.write(JSON.stringify(result) + "\n");
      } catch (e) {
        const errorResult = {
          success: false,
          operation: "unknown",
          duration_ms: 0,
          result: {},
          files_modified: [],
          warnings: [],
          errors: [{ code: "PARSE_ERROR", message: `Failed to parse request: ${e}` }],
        };
        socket.write(JSON.stringify(errorResult) + "\n");
      }
    });
  });

  server.listen(socketPath, () => {
    process.stderr.write(`CodeGraph watch: listening on ${socketPath}\n`);
    process.stderr.write(`CodeGraph watch: project ${projectRoot}\n`);
    // Write socket path to stdout so the caller can connect
    process.stdout.write(JSON.stringify({ socket: socketPath, project: projectRoot }) + "\n");
  });

  // Clean up on exit
  const cleanup = () => {
    watcher.close();
    server.close();
    try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

/**
 * Send a command to a running watch server.
 * Returns null if no server is running.
 */
export async function sendToWatch(
  projectRoot: string,
  command: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  const socketPath = getSocketPath(projectRoot);

  if (!fs.existsSync(socketPath)) {
    return null;
  }

  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath, () => {
      socket.write(JSON.stringify({ command, args }) + "\n");
    });

    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString();
      if (data.includes("\n")) {
        socket.end();
        resolve(data.trim());
      }
    });

    socket.on("error", () => {
      // Server not running or stale socket
      try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
      resolve(null);
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      socket.end();
      resolve(null);
    }, 30000);
  });
}
