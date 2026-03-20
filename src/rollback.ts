import fs from "fs";
import path from "path";

interface RollbackEntry {
  operation: string;
  timestamp: string;
  files: Array<{
    path: string;
    original_content: string;
    existed: boolean;
  }>;
}

const ROLLBACK_DIR = ".codegraph";
const ROLLBACK_FILE = "rollback.json";
const MAX_HISTORY = 10;

/**
 * Save file contents before modification so they can be restored.
 */
export function saveRollback(projectRoot: string, operation: string, filePaths: string[]): void {
  const rollbackDir = path.join(projectRoot, ROLLBACK_DIR);
  if (!fs.existsSync(rollbackDir)) {
    fs.mkdirSync(rollbackDir, { recursive: true });
  }

  const entry: RollbackEntry = {
    operation,
    timestamp: new Date().toISOString(),
    files: filePaths.map(filePath => {
      const fullPath = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
      const existed = fs.existsSync(fullPath);
      return {
        path: fullPath,
        original_content: existed ? fs.readFileSync(fullPath, "utf-8") : "",
        existed,
      };
    }),
  };

  // Load existing history
  const rollbackPath = path.join(rollbackDir, ROLLBACK_FILE);
  let history: RollbackEntry[] = [];
  if (fs.existsSync(rollbackPath)) {
    try {
      history = JSON.parse(fs.readFileSync(rollbackPath, "utf-8"));
    } catch {
      history = [];
    }
  }

  // Add new entry, trim to max
  history.push(entry);
  if (history.length > MAX_HISTORY) {
    history = history.slice(-MAX_HISTORY);
  }

  fs.writeFileSync(rollbackPath, JSON.stringify(history, null, 2), "utf-8");
}

/**
 * Undo the last operation by restoring original file contents.
 */
export function undoLast(projectRoot: string): {
  success: boolean;
  operation?: string;
  files_restored: string[];
  error?: string;
} {
  const rollbackPath = path.join(projectRoot, ROLLBACK_DIR, ROLLBACK_FILE);
  if (!fs.existsSync(rollbackPath)) {
    return { success: false, files_restored: [], error: "No rollback history found" };
  }

  let history: RollbackEntry[];
  try {
    history = JSON.parse(fs.readFileSync(rollbackPath, "utf-8"));
  } catch {
    return { success: false, files_restored: [], error: "Failed to parse rollback history" };
  }

  if (history.length === 0) {
    return { success: false, files_restored: [], error: "Rollback history is empty" };
  }

  const entry = history.pop()!;
  const filesRestored: string[] = [];

  for (const file of entry.files) {
    if (file.existed) {
      fs.writeFileSync(file.path, file.original_content, "utf-8");
    } else {
      // File was created by the operation — delete it
      if (fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
    }
    filesRestored.push(path.relative(projectRoot, file.path));
  }

  // Save updated history
  fs.writeFileSync(rollbackPath, JSON.stringify(history, null, 2), "utf-8");

  return {
    success: true,
    operation: entry.operation,
    files_restored: filesRestored,
  };
}
