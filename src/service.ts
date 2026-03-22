import ts from "typescript";
import path from "path";
import fs from "fs";
import { saveRollback } from "./rollback.js";

export interface CodeGraphResult {
  success: boolean;
  operation: string;
  duration_ms: number;
  result: Record<string, unknown>;
  files_modified: string[];
  warnings: Array<{ code: string; message: string; file?: string; line?: number }>;
  errors: Array<{ code: string; message: string; file?: string; line?: number }>;
}

interface SymbolLocation {
  fileName: string;
  position: number;
  name: string;
  kind: string;
  line: number;
  column: number;
}

/**
 * Core CodeGraph service — wraps TypeScript LanguageService
 * for agent-callable structural operations.
 */
export class CodeGraphService {
  private service: ts.LanguageService;
  private program: ts.Program;
  private projectRoot: string;
  private fileVersions: Map<string, number> = new Map();

  constructor(tsconfigPath: string) {
    const startTime = Date.now();
    this.projectRoot = path.dirname(tsconfigPath);

    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (configFile.error) {
      throw new Error(`Failed to read tsconfig: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n")}`);
    }

    const parsed = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      this.projectRoot
    );

    if (parsed.errors.length > 0) {
      const msgs = parsed.errors.map(e => ts.flattenDiagnosticMessageText(e.messageText, "\n"));
      throw new Error(`tsconfig errors: ${msgs.join(", ")}`);
    }

    const files = parsed.fileNames;
    for (const f of files) {
      this.fileVersions.set(f, 0);
    }

    const serviceHost: ts.LanguageServiceHost = {
      getScriptFileNames: () => files,
      getScriptVersion: (fileName) => String(this.fileVersions.get(fileName) ?? 0),
      getScriptSnapshot: (fileName) => {
        if (!fs.existsSync(fileName)) return undefined;
        return ts.ScriptSnapshot.fromString(fs.readFileSync(fileName, "utf-8"));
      },
      getCurrentDirectory: () => this.projectRoot,
      getCompilationSettings: () => parsed.options,
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
    };

    this.service = ts.createLanguageService(serviceHost, ts.createDocumentRegistry());
    this.program = this.service.getProgram()!;

    const elapsed = Date.now() - startTime;
    const fileCount = files.length;
    process.stderr.write(`CodeGraph: indexed ${fileCount} files in ${elapsed}ms\n`);
  }

  /**
   * Resolve a symbol name to its location(s) in the project.
   * Supports: "SymbolName", "file.ts:line", "Class.method"
   */
  resolveSymbol(symbolRef: string): SymbolLocation[] {
    // Format: file.ts:line
    const fileLineMatch = symbolRef.match(/^(.+):(\d+)$/);
    if (fileLineMatch) {
      const filePath = path.resolve(this.projectRoot, fileLineMatch[1]);
      const line = parseInt(fileLineMatch[2], 10) - 1; // 0-indexed
      const sourceFile = this.program.getSourceFile(filePath);
      if (!sourceFile) return [];
      const position = sourceFile.getPositionOfLineAndCharacter(line, 0);
      // Find the first identifier on this line
      const lineEnd = sourceFile.getPositionOfLineAndCharacter(line, sourceFile.getLineEndOfPosition(position) - position);
      const node = this.findIdentifierInRange(sourceFile, position, lineEnd);
      if (!node) return [];
      return [{
        fileName: filePath,
        position: node.getStart(),
        name: node.getText(),
        kind: this.getNodeKind(node),
        line: line + 1,
        column: node.getStart() - position + 1,
      }];
    }

    // Format: Class.method
    const parts = symbolRef.split(".");
    const results: SymbolLocation[] = [];
    const checker = this.program.getTypeChecker();

    for (const sourceFile of this.program.getSourceFiles()) {
      if (sourceFile.isDeclarationFile) continue;

      if (parts.length === 1) {
        // Simple name lookup
        this.walkTree(sourceFile, (node) => {
          if (ts.isIdentifier(node) && node.text === parts[0] && this.isDeclaration(node)) {
            const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
            results.push({
              fileName: sourceFile.fileName,
              position: node.getStart(),
              name: node.text,
              kind: this.getNodeKind(node.parent),
              line: line + 1,
              column: character + 1,
            });
          }
        });
      } else {
        // Qualified: Container.member
        this.walkTree(sourceFile, (node) => {
          if (ts.isIdentifier(node) && node.text === parts[0] && this.isDeclaration(node)) {
            // Found the container — now look for the member
            const containerNode = node.parent;
            if (ts.isClassDeclaration(containerNode) || ts.isInterfaceDeclaration(containerNode)) {
              for (const member of containerNode.members) {
                const memberName = member.name;
                if (memberName && ts.isIdentifier(memberName) && memberName.text === parts[1]) {
                  const { line, character } = sourceFile.getLineAndCharacterOfPosition(memberName.getStart());
                  results.push({
                    fileName: sourceFile.fileName,
                    position: memberName.getStart(),
                    name: `${parts[0]}.${parts[1]}`,
                    kind: this.getNodeKind(member),
                    line: line + 1,
                    column: character + 1,
                  });
                }
              }
            }
          }
        });
      }
    }

    return results;
  }

  /**
   * Find all references to a symbol.
   */
  findReferences(symbolRef: string): CodeGraphResult {
    const start = Date.now();
    const locations = this.resolveSymbol(symbolRef);

    if (locations.length === 0) {
      return this.errorResult("refs", "SYMBOL_NOT_FOUND", `No symbol '${symbolRef}' found`, start);
    }

    if (locations.length > 1) {
      return this.ambiguousResult("refs", symbolRef, locations, start);
    }

    const loc = locations[0];
    const refs = this.service.findReferences(loc.fileName, loc.position);

    const references: Array<{
      file: string;
      line: number;
      column: number;
      text: string;
      is_definition: boolean;
      is_write: boolean;
    }> = [];

    if (refs) {
      for (const refGroup of refs) {
        for (const ref of refGroup.references) {
          const sourceFile = this.program.getSourceFile(ref.fileName);
          if (!sourceFile || sourceFile.isDeclarationFile) continue;
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(ref.textSpan.start);
          const lineText = sourceFile.getFullText().substring(
            sourceFile.getPositionOfLineAndCharacter(line, 0),
            sourceFile.getLineEndOfPosition(ref.textSpan.start)
          ).trim();

          references.push({
            file: path.relative(this.projectRoot, ref.fileName),
            line: line + 1,
            column: character + 1,
            text: lineText,
            is_definition: ref.isDefinition ?? false,
            is_write: ref.isWriteAccess ?? false,
          });
        }
      }
    }

    return {
      success: true,
      operation: "refs",
      duration_ms: Date.now() - start,
      result: {
        symbol: loc.name,
        kind: loc.kind,
        defined_in: `${path.relative(this.projectRoot, loc.fileName)}:${loc.line}`,
        total_references: references.length,
        references,
      },
      files_modified: [],
      warnings: [],
      errors: [],
    };
  }

  /**
   * Find all callers of a function.
   */
  findCallers(symbolRef: string): CodeGraphResult {
    const start = Date.now();
    const refsResult = this.findReferences(symbolRef);
    if (!refsResult.success) return { ...refsResult, operation: "callers" };

    const refs = (refsResult.result.references as Array<{
      file: string; line: number; column: number; text: string;
      is_definition: boolean; is_write: boolean;
    }>).filter(r => !r.is_definition);

    return {
      success: true,
      operation: "callers",
      duration_ms: Date.now() - start,
      result: {
        symbol: refsResult.result.symbol,
        kind: refsResult.result.kind,
        defined_in: refsResult.result.defined_in,
        caller_count: refs.length,
        callers: refs.map(r => ({
          file: r.file,
          line: r.line,
          text: r.text,
        })),
      },
      files_modified: [],
      warnings: [],
      errors: [],
    };
  }

  /**
   * Check if a symbol is unused (zero non-definition references).
   */
  checkUnused(symbolRef: string): CodeGraphResult {
    const start = Date.now();
    const refsResult = this.findReferences(symbolRef);
    if (!refsResult.success) return { ...refsResult, operation: "check-unused" };

    const refs = (refsResult.result.references as Array<{
      is_definition: boolean;
    }>);
    const usages = refs.filter(r => !r.is_definition);

    return {
      success: true,
      operation: "check-unused",
      duration_ms: Date.now() - start,
      result: {
        symbol: refsResult.result.symbol,
        kind: refsResult.result.kind,
        defined_in: refsResult.result.defined_in,
        is_unused: usages.length === 0,
        usage_count: usages.length,
        safe_to_delete: usages.length === 0,
      },
      files_modified: [],
      warnings: [],
      errors: [],
    };
  }

  /**
   * Rename a symbol across the entire project.
   */
  rename(symbolRef: string, newName: string, dryRun: boolean = false): CodeGraphResult {
    const start = Date.now();
    const locations = this.resolveSymbol(symbolRef);

    if (locations.length === 0) {
      return this.errorResult("rename", "SYMBOL_NOT_FOUND", `No symbol '${symbolRef}' found`, start);
    }
    if (locations.length > 1) {
      return this.ambiguousResult("rename", symbolRef, locations, start);
    }

    const loc = locations[0];

    // Check if rename is valid
    const renameInfo = this.service.getRenameInfo(loc.fileName, loc.position);
    if (!renameInfo.canRename) {
      return this.errorResult("rename", "CANNOT_RENAME", renameInfo.localizedErrorMessage ?? "Symbol cannot be renamed", start);
    }

    // Find all rename locations
    const renameLocations = this.service.findRenameLocations(
      loc.fileName, loc.position,
      /* findInStrings */ false,
      /* findInComments */ false
    );

    if (!renameLocations || renameLocations.length === 0) {
      return this.errorResult("rename", "NO_LOCATIONS", "No rename locations found", start);
    }

    // Group by file
    const byFile = new Map<string, ts.RenameLocation[]>();
    for (const rl of renameLocations) {
      const existing = byFile.get(rl.fileName) ?? [];
      existing.push(rl);
      byFile.set(rl.fileName, existing);
    }

    const fileChanges: Array<{
      file: string;
      changes: number;
    }> = [];

    const filesModified: string[] = [];

    if (!dryRun) {
      // Save rollback before modifying files
      saveRollback(this.projectRoot, "rename", [...byFile.keys()]);

      // Apply changes (process in reverse order within each file to preserve positions)
      for (const [fileName, locs] of byFile) {
        const sourceFile = this.program.getSourceFile(fileName);
        if (!sourceFile) continue;

        let content = sourceFile.getFullText();
        // Sort by position descending so replacements don't shift positions
        const sorted = [...locs].sort((a, b) => b.textSpan.start - a.textSpan.start);

        for (const rl of sorted) {
          const before = content.substring(0, rl.textSpan.start);
          const after = content.substring(rl.textSpan.start + rl.textSpan.length);
          content = before + newName + after;
        }

        fs.writeFileSync(fileName, content, "utf-8");
        const relPath = path.relative(this.projectRoot, fileName);
        filesModified.push(relPath);
        fileChanges.push({ file: relPath, changes: locs.length });
      }
    } else {
      for (const [fileName, locs] of byFile) {
        const relPath = path.relative(this.projectRoot, fileName);
        filesModified.push(relPath);
        fileChanges.push({ file: relPath, changes: locs.length });
      }
    }

    return {
      success: true,
      operation: "rename",
      duration_ms: Date.now() - start,
      result: {
        renamed: `${loc.name} → ${newName}`,
        total_locations: renameLocations.length,
        files_affected: byFile.size,
        dry_run: dryRun,
        file_changes: fileChanges,
      },
      files_modified: filesModified,
      warnings: [],
      errors: [],
    };
  }

  /**
   * Scan for all dead (unreferenced) exported symbols in a scope.
   */
  deadCode(scope?: string): CodeGraphResult {
    const start = Date.now();
    const checker = this.program.getTypeChecker();
    const dead: Array<{
      symbol: string;
      kind: string;
      file: string;
      line: number;
      export_only: boolean;
    }> = [];

    for (const sourceFile of this.program.getSourceFiles()) {
      if (sourceFile.isDeclarationFile) continue;
      const relPath = path.relative(this.projectRoot, sourceFile.fileName);
      if (relPath.startsWith("..") || relPath.includes("node_modules")) continue;
      if (scope && !relPath.startsWith(scope)) continue;

      this.walkTree(sourceFile, (node) => {
        if (!ts.isIdentifier(node)) return;
        if (!this.isDeclaration(node)) return;

        // Only check exported symbols and top-level declarations
        const parent = node.parent;
        const isExported = this.hasExportModifier(parent);
        const isTopLevel = parent.parent === sourceFile ||
          (ts.isVariableDeclarationList(parent.parent) && parent.parent.parent.parent === sourceFile);

        if (!isExported && !isTopLevel) return;

        // Skip private/internal by convention (underscore prefix)
        if (node.text.startsWith("_")) return;

        const refs = this.service.findReferences(sourceFile.fileName, node.getStart());
        if (!refs) return;

        let usageCount = 0;
        for (const refGroup of refs) {
          for (const ref of refGroup.references) {
            if (!ref.isDefinition) {
              // Don't count re-exports as real usage
              const refSource = this.program.getSourceFile(ref.fileName);
              if (refSource) {
                const refLine = refSource.getFullText().substring(
                  refSource.getPositionOfLineAndCharacter(
                    refSource.getLineAndCharacterOfPosition(ref.textSpan.start).line, 0
                  ),
                  refSource.getLineEndOfPosition(ref.textSpan.start)
                ).trim();
                if (refLine.startsWith("export") && refLine.includes("from")) continue;
              }
              usageCount++;
            }
          }
        }

        if (usageCount === 0) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          dead.push({
            symbol: node.text,
            kind: this.getNodeKind(parent),
            file: relPath,
            line: line + 1,
            export_only: isExported,
          });
        }
      });
    }

    return {
      success: true,
      operation: "dead-code",
      duration_ms: Date.now() - start,
      result: {
        scope: scope ?? ".",
        dead_symbols: dead,
        total_dead: dead.length,
      },
      files_modified: [],
      warnings: [],
      errors: [],
    };
  }

  /**
   * Analyze the impact of changing a symbol before making the change.
   */
  impact(symbolRef: string): CodeGraphResult {
    const start = Date.now();
    const locations = this.resolveSymbol(symbolRef);

    if (locations.length === 0) {
      return this.errorResult("impact", "SYMBOL_NOT_FOUND", `No symbol '${symbolRef}' found`, start);
    }
    if (locations.length > 1) {
      return this.ambiguousResult("impact", symbolRef, locations, start);
    }

    const loc = locations[0];
    const refs = this.service.findReferences(loc.fileName, loc.position);

    const directRefs: Array<{ file: string; line: number; text: string }> = [];
    const filesAffected = new Set<string>();
    const exportSurfaces: Array<{ file: string; line: number; surface: string }> = [];

    if (refs) {
      for (const refGroup of refs) {
        for (const ref of refGroup.references) {
          if (ref.isDefinition) continue;
          const sourceFile = this.program.getSourceFile(ref.fileName);
          if (!sourceFile || sourceFile.isDeclarationFile) continue;

          const relPath = path.relative(this.projectRoot, ref.fileName);
          if (relPath.startsWith("..")) continue;

          filesAffected.add(relPath);
          const { line } = sourceFile.getLineAndCharacterOfPosition(ref.textSpan.start);
          const lineText = sourceFile.getFullText().substring(
            sourceFile.getPositionOfLineAndCharacter(line, 0),
            sourceFile.getLineEndOfPosition(ref.textSpan.start)
          ).trim();

          directRefs.push({ file: relPath, line: line + 1, text: lineText });

          // Detect export/API surface exposure
          if (lineText.startsWith("export")) {
            let surface = "public API export";
            if (lineText.includes("from")) surface = "re-export";
            else if (lineText.startsWith("export function")) surface = "exported function signature";
            else if (lineText.startsWith("export class")) surface = "exported class";
            else if (lineText.startsWith("export interface")) surface = "exported interface";
            else if (lineText.startsWith("export type")) surface = "exported type";
            else if (lineText.startsWith("export const") || lineText.startsWith("export let")) surface = "exported variable";
            exportSurfaces.push({ file: relPath, line: line + 1, surface });
          }
        }
      }
    }

    // Check if the symbol itself is exported (use TypeChecker for reliability)
    const sourceFile = this.program.getSourceFile(loc.fileName);
    let isExported = false;
    if (sourceFile) {
      const checker = this.program.getTypeChecker();
      const sourceSymbol = checker.getSymbolAtLocation(sourceFile);
      if (sourceSymbol) {
        const exports = checker.getExportsOfModule(sourceSymbol);
        isExported = exports.some(e => e.getName() === loc.name);
      }
    }

    // Determine test files
    const testFiles = [...filesAffected].filter(f =>
      f.includes("test") || f.includes("spec") || f.includes("__tests__")
    );

    const riskLevel = isExported && exportSurfaces.length > 0 ? "high" :
                      filesAffected.size > 5 ? "medium" : "low";

    return {
      success: true,
      operation: "impact",
      duration_ms: Date.now() - start,
      result: {
        symbol: loc.name,
        kind: loc.kind,
        defined_in: `${path.relative(this.projectRoot, loc.fileName)}:${loc.line}`,
        is_exported: isExported,
        direct_references: directRefs.length,
        files_affected: filesAffected.size,
        test_files_affected: testFiles.length,
        risk_level: riskLevel,
        references: directRefs,
        export_surfaces: exportSurfaces,
        test_files: testFiles,
      },
      files_modified: [],
      warnings: isExported ? [{
        code: "EXPORTED_SYMBOL",
        message: `${loc.name} is exported. External consumers may break.`,
      }] : [],
      errors: [],
    };
  }

  /**
   * Move a symbol from one file to another, updating all imports.
   */
  moveSymbol(symbolRef: string, targetFile: string, dryRun: boolean = false): CodeGraphResult {
    const start = Date.now();
    const locations = this.resolveSymbol(symbolRef);

    if (locations.length === 0) {
      return this.errorResult("move", "SYMBOL_NOT_FOUND", `No symbol '${symbolRef}' found`, start);
    }
    if (locations.length > 1) {
      return this.ambiguousResult("move", symbolRef, locations, start);
    }

    const loc = locations[0];
    const sourceFile = this.program.getSourceFile(loc.fileName);
    if (!sourceFile) {
      return this.errorResult("move", "FILE_NOT_FOUND", `Source file not found`, start);
    }

    const targetPath = path.resolve(this.projectRoot, targetFile);

    // Find the full declaration node
    const declNode = this.findDeclarationAtPosition(sourceFile, loc.position);
    if (!declNode) {
      return this.errorResult("move", "NO_DECLARATION", `Could not find declaration for '${symbolRef}'`, start);
    }

    // Extract the declaration text
    const declText = declNode.getFullText(sourceFile).trimStart();

    // Find all files that import this symbol from the source file
    const refs = this.service.findReferences(loc.fileName, loc.position);
    const importingFiles = new Map<string, { line: number; text: string }>();

    if (refs) {
      for (const refGroup of refs) {
        for (const ref of refGroup.references) {
          if (ref.fileName === loc.fileName) continue; // skip source file
          const refSourceFile = this.program.getSourceFile(ref.fileName);
          if (!refSourceFile || refSourceFile.isDeclarationFile) continue;
          const relPath = path.relative(this.projectRoot, ref.fileName);
          if (relPath.startsWith("..")) continue;

          const { line } = refSourceFile.getLineAndCharacterOfPosition(ref.textSpan.start);
          const lineText = refSourceFile.getFullText().substring(
            refSourceFile.getPositionOfLineAndCharacter(line, 0),
            refSourceFile.getLineEndOfPosition(ref.textSpan.start)
          ).trim();

          // Only track import statements
          if (lineText.startsWith("import") || (lineText.startsWith("export") && lineText.includes("from"))) {
            importingFiles.set(ref.fileName, { line: line + 1, text: lineText });
          }
        }
      }
    }

    // Collect what dependencies the declaration needs (imports used by the moved code)
    const depsNeeded: string[] = [];
    this.walkTree(declNode, (node) => {
      if (ts.isIdentifier(node) && node.parent && !this.isDeclaration(node)) {
        const symbol = this.program.getTypeChecker().getSymbolAtLocation(node);
        if (symbol && symbol.declarations) {
          for (const decl of symbol.declarations) {
            const declFile = decl.getSourceFile();
            if (declFile.fileName !== loc.fileName && declFile.fileName !== targetPath && !declFile.isDeclarationFile) {
              const name = symbol.getName();
              if (!depsNeeded.includes(name)) {
                depsNeeded.push(name);
              }
            }
          }
        }
      }
    });

    const filesModified: string[] = [];
    const importUpdates: Array<{ file: string; action: string }> = [];

    if (!dryRun) {
      // Save rollback before modifying files
      const allFiles = [targetPath, loc.fileName, ...importingFiles.keys()];
      saveRollback(this.projectRoot, "move", allFiles);

      // 1. Add declaration to target file
      const exportPrefix = this.hasExportModifier(declNode) ? "" : "export ";
      const targetContent = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf-8") : "";

      // Build import for the target file (import deps from source)
      let newImports = "";
      if (depsNeeded.length > 0) {
        const sourceRelative = this.getRelativeImportPath(targetPath, loc.fileName);
        // Check which deps come from the source file vs other files
        // For simplicity, we'll let the user handle complex dependency chains
      }

      const newContent = targetContent + (targetContent ? "\n\n" : "") + `${exportPrefix}${declText}\n`;
      fs.writeFileSync(targetPath, newContent, "utf-8");
      filesModified.push(path.relative(this.projectRoot, targetPath));

      // 2. Remove declaration from source file
      let sourceContent = sourceFile.getFullText();
      const declStart = declNode.getFullStart();
      const declEnd = declNode.getEnd();
      sourceContent = sourceContent.substring(0, declStart) + sourceContent.substring(declEnd);
      fs.writeFileSync(loc.fileName, sourceContent, "utf-8");
      filesModified.push(path.relative(this.projectRoot, loc.fileName));

      // 3. Update imports in all consuming files
      for (const [importingFile, importInfo] of importingFiles) {
        let content = fs.readFileSync(importingFile, "utf-8");

        const oldImportFrom = this.getRelativeImportPath(importingFile, loc.fileName);
        const newImportFrom = this.getRelativeImportPath(importingFile, targetPath);

        // Replace import source for this symbol
        // Simple approach: add a new import line for the symbol from target
        const newImportLine = `import { ${loc.name} } from "${newImportFrom}";`;

        // Remove symbol from old import
        const oldImportRegex = new RegExp(
          `(import\\s*\\{[^}]*?)\\b${loc.name}\\b,?\\s*([^}]*\\}\\s*from\\s*["']${oldImportFrom.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'];?)`,
        );
        const match = content.match(oldImportRegex);
        if (match) {
          let updatedImport = match[0].replace(new RegExp(`\\b${loc.name}\\b,?\\s*`), "");
          // Clean up trailing/leading commas
          updatedImport = updatedImport.replace(/\{\s*,/, "{").replace(/,\s*\}/, " }");
          // If import is now empty, remove it
          if (updatedImport.match(/\{\s*\}/)) {
            content = content.replace(match[0], "");
          } else {
            content = content.replace(match[0], updatedImport);
          }
          content = newImportLine + "\n" + content;
        }

        fs.writeFileSync(importingFile, content, "utf-8");
        const relPath = path.relative(this.projectRoot, importingFile);
        filesModified.push(relPath);
        importUpdates.push({
          file: relPath,
          action: `Updated import: now imports ${loc.name} from ${path.relative(this.projectRoot, targetPath)}`,
        });
      }
    } else {
      filesModified.push(path.relative(this.projectRoot, targetPath));
      filesModified.push(path.relative(this.projectRoot, loc.fileName));
      for (const [importingFile] of importingFiles) {
        filesModified.push(path.relative(this.projectRoot, importingFile));
        importUpdates.push({
          file: path.relative(this.projectRoot, importingFile),
          action: `Would update import to point to ${path.relative(this.projectRoot, targetPath)}`,
        });
      }
    }

    return {
      success: true,
      operation: "move",
      duration_ms: Date.now() - start,
      result: {
        moved: loc.name,
        from: path.relative(this.projectRoot, loc.fileName),
        to: path.relative(this.projectRoot, targetPath),
        dry_run: dryRun,
        dependencies_needed: depsNeeded,
        import_updates: importUpdates,
        files_affected: filesModified.length,
      },
      files_modified: filesModified,
      warnings: depsNeeded.length > 0 ? [{
        code: "DEPENDENCIES",
        message: `Moved symbol depends on: ${depsNeeded.join(", ")}. You may need to add imports in the target file.`,
      }] : [],
      errors: [],
    };
  }

  /**
   * Add a parameter to a function and update all call sites.
   */
  addParam(
    symbolRef: string,
    paramName: string,
    paramType: string,
    defaultValue?: string,
    position?: number,
  ): CodeGraphResult {
    const start = Date.now();
    const locations = this.resolveSymbol(symbolRef);

    if (locations.length === 0) {
      return this.errorResult("add-param", "SYMBOL_NOT_FOUND", `No symbol '${symbolRef}' found`, start);
    }
    if (locations.length > 1) {
      return this.ambiguousResult("add-param", symbolRef, locations, start);
    }

    const loc = locations[0];
    if (loc.kind !== "function" && loc.kind !== "method") {
      return this.errorResult("add-param", "NOT_A_FUNCTION", `'${symbolRef}' is a ${loc.kind}, not a function`, start);
    }

    const sourceFile = this.program.getSourceFile(loc.fileName);
    if (!sourceFile) {
      return this.errorResult("add-param", "FILE_NOT_FOUND", `Source file not found`, start);
    }

    // Find the function declaration
    const funcNode = this.findDeclarationAtPosition(sourceFile, loc.position);
    if (!funcNode || (!ts.isFunctionDeclaration(funcNode) && !ts.isMethodDeclaration(funcNode) && !ts.isArrowFunction(funcNode))) {
      return this.errorResult("add-param", "NOT_A_FUNCTION", `Could not find function declaration`, start);
    }

    const funcDecl = funcNode as ts.FunctionDeclaration | ts.MethodDeclaration;
    const params = funcDecl.parameters;
    const insertPos = position !== undefined ? Math.min(position, params.length) : params.length;

    // Find all call sites
    const refs = this.service.findReferences(loc.fileName, loc.position);
    const callSites: Array<{ fileName: string; position: number; line: number }> = [];

    if (refs) {
      for (const refGroup of refs) {
        for (const ref of refGroup.references) {
          if (ref.isDefinition) continue;
          const refSourceFile = this.program.getSourceFile(ref.fileName);
          if (!refSourceFile || refSourceFile.isDeclarationFile) continue;
          const relPath = path.relative(this.projectRoot, ref.fileName);
          if (relPath.startsWith("..")) continue;

          // Check if this reference is a call expression
          const { line: refLine } = refSourceFile.getLineAndCharacterOfPosition(ref.textSpan.start);
          const refLineText = refSourceFile.getFullText().substring(
            refSourceFile.getPositionOfLineAndCharacter(refLine, 0),
            refSourceFile.getLineEndOfPosition(ref.textSpan.start)
          ).trim();

          // Skip imports and re-exports
          if (refLineText.startsWith("import") || (refLineText.startsWith("export") && refLineText.includes("from"))) {
            continue;
          }

          // Check if the reference is followed by a "(" — a call site
          const afterRef = refSourceFile.getFullText().substring(ref.textSpan.start + ref.textSpan.length).trimStart();
          if (afterRef.startsWith("(")) {
            callSites.push({
              fileName: ref.fileName,
              position: ref.textSpan.start,
              line: refLine + 1,
            });
          }
        }
      }
    }

    const filesModified: string[] = [];
    const callSiteUpdates: Array<{ file: string; line: number }> = [];

    // Group call sites by file, process in reverse position order
    const callsByFile = new Map<string, typeof callSites>();
    for (const cs of callSites) {
      const existing = callsByFile.get(cs.fileName) ?? [];
      existing.push(cs);
      callsByFile.set(cs.fileName, existing);
    }

    // Save rollback before modifying files
    saveRollback(this.projectRoot, "add-param", [loc.fileName, ...callsByFile.keys()]);

    // 1. Update call sites (add default value at each)
    for (const [fileName, sites] of callsByFile) {
      let content = fs.readFileSync(fileName, "utf-8");
      const sorted = [...sites].sort((a, b) => b.position - a.position);

      for (const site of sorted) {
        // Find the call expression's argument list
        const fileContent = content;
        const callStart = site.position;
        // Find opening paren after the function name
        let parenStart = fileContent.indexOf("(", callStart);
        if (parenStart === -1) continue;

        // Find matching close paren
        let depth = 1;
        let i = parenStart + 1;
        while (i < fileContent.length && depth > 0) {
          if (fileContent[i] === "(") depth++;
          if (fileContent[i] === ")") depth--;
          i++;
        }
        const parenEnd = i - 1; // position of closing paren

        // Count existing args
        const argsText = fileContent.substring(parenStart + 1, parenEnd).trim();
        const hasArgs = argsText.length > 0;
        const argValue = defaultValue ?? `undefined /* TODO: ${paramName} */`;

        if (insertPos === 0) {
          // Insert at beginning
          if (hasArgs) {
            content = content.substring(0, parenStart + 1) + argValue + ", " + content.substring(parenStart + 1);
          } else {
            content = content.substring(0, parenStart + 1) + argValue + content.substring(parenStart + 1);
          }
        } else {
          // Insert at position or end
          if (hasArgs) {
            content = content.substring(0, parenEnd) + ", " + argValue + content.substring(parenEnd);
          } else {
            content = content.substring(0, parenEnd) + argValue + content.substring(parenEnd);
          }
        }

        callSiteUpdates.push({
          file: path.relative(this.projectRoot, fileName),
          line: site.line,
        });
      }

      fs.writeFileSync(fileName, content, "utf-8");
      filesModified.push(path.relative(this.projectRoot, fileName));
    }

    // 2. Update function declaration (add parameter)
    let sourceContent = fs.readFileSync(loc.fileName, "utf-8");
    const newParam = defaultValue
      ? `${paramName}: ${paramType} = ${defaultValue}`
      : `${paramName}: ${paramType}`;

    if (params.length === 0) {
      // No existing params — insert between parens
      const openParen = sourceContent.indexOf("(", loc.position);
      sourceContent = sourceContent.substring(0, openParen + 1) + newParam + sourceContent.substring(openParen + 1);
    } else if (insertPos >= params.length) {
      // Add after last param
      const lastParam = params[params.length - 1];
      const lastParamEnd = lastParam.getEnd();
      sourceContent = sourceContent.substring(0, lastParamEnd) + ", " + newParam + sourceContent.substring(lastParamEnd);
    } else {
      // Insert at position
      const paramAtPos = params[insertPos];
      const paramStart = paramAtPos.getStart();
      sourceContent = sourceContent.substring(0, paramStart) + newParam + ", " + sourceContent.substring(paramStart);
    }

    fs.writeFileSync(loc.fileName, sourceContent, "utf-8");
    if (!filesModified.includes(path.relative(this.projectRoot, loc.fileName))) {
      filesModified.push(path.relative(this.projectRoot, loc.fileName));
    }

    return {
      success: true,
      operation: "add-param",
      duration_ms: Date.now() - start,
      result: {
        function: loc.name,
        parameter_added: { name: paramName, type: paramType, position: insertPos, default: defaultValue },
        call_sites_updated: callSiteUpdates.length,
        files_modified: filesModified.length,
        call_sites: callSiteUpdates,
      },
      files_modified: filesModified,
      warnings: defaultValue ? [] : [{
        code: "NO_DEFAULT",
        message: `No default value provided. Call sites will receive 'undefined'. Consider providing --default.`,
      }],
      errors: [],
    };
  }

  /**
   * Delete a symbol and clean up its imports/exports.
   */
  deleteSymbol(symbolRef: string, dryRun: boolean = false): CodeGraphResult {
    const start = Date.now();
    const locations = this.resolveSymbol(symbolRef);

    if (locations.length === 0) {
      return this.errorResult("delete", "SYMBOL_NOT_FOUND", `No symbol '${symbolRef}' found`, start);
    }
    if (locations.length > 1) {
      return this.ambiguousResult("delete", symbolRef, locations, start);
    }

    const loc = locations[0];

    // Check if it's actually unused
    const unusedResult = this.checkUnused(symbolRef);
    if (unusedResult.success && !(unusedResult.result as { is_unused: boolean }).is_unused) {
      const usageCount = (unusedResult.result as { usage_count: number }).usage_count;
      return {
        success: false,
        operation: "delete",
        duration_ms: Date.now() - start,
        result: { usage_count: usageCount },
        files_modified: [],
        warnings: [],
        errors: [{
          code: "SYMBOL_IN_USE",
          message: `'${symbolRef}' has ${usageCount} usage(s). Use --force or remove usages first. Run 'codegraph callers --of ${symbolRef}' to see them.`,
        }],
      };
    }

    const sourceFile = this.program.getSourceFile(loc.fileName);
    if (!sourceFile) {
      return this.errorResult("delete", "FILE_NOT_FOUND", `Source file not found`, start);
    }

    // Find the declaration node
    const declNode = this.findDeclarationAtPosition(sourceFile, loc.position);
    if (!declNode) {
      return this.errorResult("delete", "NO_DECLARATION", `Could not find declaration for '${symbolRef}'`, start);
    }

    // Find files that import/re-export this symbol (to clean up)
    const refs = this.service.findReferences(loc.fileName, loc.position);
    const importFiles = new Map<string, { line: number; text: string }>();
    if (refs) {
      for (const refGroup of refs) {
        for (const ref of refGroup.references) {
          if (ref.fileName === loc.fileName) continue;
          const refSf = this.program.getSourceFile(ref.fileName);
          if (!refSf || refSf.isDeclarationFile) continue;
          const relPath = path.relative(this.projectRoot, ref.fileName);
          if (relPath.startsWith("..")) continue;
          const { line } = refSf.getLineAndCharacterOfPosition(ref.textSpan.start);
          const lineText = refSf.getFullText().substring(
            refSf.getPositionOfLineAndCharacter(line, 0),
            refSf.getLineEndOfPosition(ref.textSpan.start)
          ).trim();
          if (lineText.startsWith("import") || (lineText.startsWith("export") && lineText.includes("from"))) {
            importFiles.set(ref.fileName, { line: line + 1, text: lineText });
          }
        }
      }
    }

    const filesModified: string[] = [];
    const cleanedImports: Array<{ file: string; action: string }> = [];

    if (!dryRun) {
      // Save rollback
      saveRollback(this.projectRoot, "delete", [loc.fileName, ...importFiles.keys()]);

      // 1. Remove the declaration from source file
      let content = sourceFile.getFullText();
      const declStart = declNode.getFullStart();
      const declEnd = declNode.getEnd();
      // Also remove trailing newline if present
      let end = declEnd;
      if (content[end] === "\n") end++;
      content = content.substring(0, declStart) + content.substring(end);
      fs.writeFileSync(loc.fileName, content, "utf-8");
      filesModified.push(path.relative(this.projectRoot, loc.fileName));

      // 2. Clean up imports/re-exports in other files
      for (const [importFile, importInfo] of importFiles) {
        let fileContent = fs.readFileSync(importFile, "utf-8");
        const lines = fileContent.split("\n");
        const lineIdx = importInfo.line - 1;
        const importLine = lines[lineIdx];

        if (importLine) {
          // Remove the symbol from the import
          let updated = importLine.replace(new RegExp(`\\b${loc.name}\\b,?\\s*`), "");
          updated = updated.replace(/\{\s*,/, "{").replace(/,\s*\}/, " }").replace(/,\s*,/, ",");

          // If import is now empty, remove the line
          if (updated.match(/\{\s*\}/) || updated.match(/import\s*\{\s*\}\s*from/)) {
            lines.splice(lineIdx, 1);
          } else {
            lines[lineIdx] = updated;
          }

          fileContent = lines.join("\n");
          fs.writeFileSync(importFile, fileContent, "utf-8");
          const relPath = path.relative(this.projectRoot, importFile);
          filesModified.push(relPath);
          cleanedImports.push({ file: relPath, action: `Removed '${loc.name}' from import` });
        }
      }
    } else {
      filesModified.push(path.relative(this.projectRoot, loc.fileName));
      for (const [importFile] of importFiles) {
        const relPath = path.relative(this.projectRoot, importFile);
        filesModified.push(relPath);
        cleanedImports.push({ file: relPath, action: `Would remove '${loc.name}' from import` });
      }
    }

    return {
      success: true,
      operation: "delete",
      duration_ms: Date.now() - start,
      result: {
        deleted: loc.name,
        kind: loc.kind,
        from: path.relative(this.projectRoot, loc.fileName),
        dry_run: dryRun,
        imports_cleaned: cleanedImports,
        files_affected: filesModified.length,
      },
      files_modified: filesModified,
      warnings: [],
      errors: [],
    };
  }

  /**
   * Run the type checker and return structured diagnostics.
   */
  typeCheck(scope?: string): CodeGraphResult {
    const start = Date.now();
    const diagnostics: Array<{
      file: string;
      line: number;
      column: number;
      code: number;
      category: string;
      message: string;
    }> = [];

    const allDiagnostics = [
      ...this.program.getSemanticDiagnostics(),
      ...this.program.getSyntacticDiagnostics(),
    ];

    for (const diag of allDiagnostics) {
      if (!diag.file) continue;
      const relPath = path.relative(this.projectRoot, diag.file.fileName);
      if (relPath.startsWith("..") || relPath.includes("node_modules")) continue;
      if (scope && !relPath.startsWith(scope)) continue;

      const { line, character } = diag.file.getLineAndCharacterOfPosition(diag.start ?? 0);
      const category = diag.category === ts.DiagnosticCategory.Error ? "error"
        : diag.category === ts.DiagnosticCategory.Warning ? "warning" : "info";

      diagnostics.push({
        file: relPath,
        line: line + 1,
        column: character + 1,
        code: diag.code,
        category,
        message: ts.flattenDiagnosticMessageText(diag.messageText, "\n"),
      });
    }

    const errors = diagnostics.filter(d => d.category === "error");
    const warnings = diagnostics.filter(d => d.category === "warning");

    return {
      success: true,
      operation: "type-check",
      duration_ms: Date.now() - start,
      result: {
        scope: scope ?? ".",
        total_errors: errors.length,
        total_warnings: warnings.length,
        pass: errors.length === 0,
        diagnostics,
      },
      files_modified: [],
      warnings: [],
      errors: [],
    };
  }

  /**
   * Get the dependencies of a symbol — what it imports, calls, and references.
   */
  deps(symbolRef: string): CodeGraphResult {
    const start = Date.now();
    const locations = this.resolveSymbol(symbolRef);

    if (locations.length === 0) {
      return this.errorResult("deps", "SYMBOL_NOT_FOUND", `No symbol '${symbolRef}' found`, start);
    }
    if (locations.length > 1) {
      return this.ambiguousResult("deps", symbolRef, locations, start);
    }

    const loc = locations[0];
    const sourceFile = this.program.getSourceFile(loc.fileName);
    if (!sourceFile) {
      return this.errorResult("deps", "FILE_NOT_FOUND", `Source file not found`, start);
    }

    const checker = this.program.getTypeChecker();
    const declNode = this.findDeclarationAtPosition(sourceFile, loc.position);
    if (!declNode) {
      return this.errorResult("deps", "NO_DECLARATION", `Could not find declaration`, start);
    }

    const imports: Array<{ symbol: string; from: string; kind: string }> = [];
    const calls: Array<{ symbol: string; file: string; line: number }> = [];
    const typeRefs: Array<{ symbol: string; kind: string }> = [];
    const seen = new Set<string>();

    this.walkTree(declNode, (node) => {
      if (ts.isIdentifier(node) && node !== declNode && node.text !== loc.name) {
        const sym = checker.getSymbolAtLocation(node);
        if (!sym || seen.has(node.text)) return;

        const decls = sym.getDeclarations();
        if (!decls || decls.length === 0) return;

        const declFile = decls[0].getSourceFile();
        if (declFile.isDeclarationFile) return;

        const declRelPath = path.relative(this.projectRoot, declFile.fileName);

        // Is it from a different file? (import)
        if (declFile.fileName !== loc.fileName) {
          if (!seen.has(`import:${node.text}`)) {
            seen.add(`import:${node.text}`);
            imports.push({
              symbol: node.text,
              from: declRelPath,
              kind: this.getNodeKind(decls[0]),
            });
          }
        }

        // Is it a call?
        if (node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          calls.push({
            symbol: node.text,
            file: declRelPath,
            line: line + 1,
          });
        }

        // Is it a type reference?
        if (node.parent && (
          ts.isTypeReferenceNode(node.parent) ||
          ts.isExpressionWithTypeArguments(node.parent)
        )) {
          if (!seen.has(`type:${node.text}`)) {
            seen.add(`type:${node.text}`);
            typeRefs.push({
              symbol: node.text,
              kind: this.getNodeKind(decls[0]),
            });
          }
        }
      }
    });

    return {
      success: true,
      operation: "deps",
      duration_ms: Date.now() - start,
      result: {
        symbol: loc.name,
        kind: loc.kind,
        defined_in: `${path.relative(this.projectRoot, loc.fileName)}:${loc.line}`,
        imports,
        calls,
        type_references: typeRefs,
        total_dependencies: imports.length + typeRefs.length,
      },
      files_modified: [],
      warnings: [],
      errors: [],
    };
  }

  /**
   * List all exports of a module/directory.
   */
  exports(modulePath: string): CodeGraphResult {
    const start = Date.now();
    const fullPath = path.resolve(this.projectRoot, modulePath);
    const checker = this.program.getTypeChecker();

    const exportList: Array<{
      symbol: string;
      kind: string;
      file: string;
      line: number;
      re_exported: boolean;
    }> = [];

    // Find source files matching the module path
    const matchingFiles: ts.SourceFile[] = [];
    for (const sf of this.program.getSourceFiles()) {
      if (sf.isDeclarationFile) continue;
      const relPath = path.relative(this.projectRoot, sf.fileName);
      if (relPath.startsWith("..") || relPath.includes("node_modules")) continue;

      if (fs.statSync(fullPath).isDirectory()) {
        if (sf.fileName.startsWith(fullPath)) {
          matchingFiles.push(sf);
        }
      } else {
        // Exact file match
        if (sf.fileName === fullPath || sf.fileName === fullPath + ".ts" || sf.fileName === fullPath + ".tsx") {
          matchingFiles.push(sf);
        }
      }
    }

    if (matchingFiles.length === 0) {
      return this.errorResult("exports", "MODULE_NOT_FOUND", `No module found at '${modulePath}'`, start);
    }

    for (const sf of matchingFiles) {
      const fileSymbol = checker.getSymbolAtLocation(sf);
      if (!fileSymbol) continue;

      const exports = checker.getExportsOfModule(fileSymbol);
      for (const exp of exports) {
        const decls = exp.getDeclarations();
        if (!decls || decls.length === 0) continue;

        const decl = decls[0];
        const declFile = decl.getSourceFile();
        const { line } = declFile.getLineAndCharacterOfPosition(decl.getStart());

        const isReExport = declFile.fileName !== sf.fileName;

        exportList.push({
          symbol: exp.getName(),
          kind: this.getNodeKind(decl),
          file: path.relative(this.projectRoot, declFile.fileName),
          line: line + 1,
          re_exported: isReExport,
        });
      }
    }

    return {
      success: true,
      operation: "exports",
      duration_ms: Date.now() - start,
      result: {
        module: modulePath,
        files_scanned: matchingFiles.length,
        total_exports: exportList.length,
        exports: exportList,
      },
      files_modified: [],
      warnings: [],
      errors: [],
    };
  }

  /**
   * Get the full resolved type signature of a symbol.
   */
  signature(symbolRef: string): CodeGraphResult {
    const start = Date.now();
    const locations = this.resolveSymbol(symbolRef);

    if (locations.length === 0) {
      return this.errorResult("signature", "SYMBOL_NOT_FOUND", `No symbol '${symbolRef}' found`, start);
    }
    if (locations.length > 1) {
      return this.ambiguousResult("signature", symbolRef, locations, start);
    }

    const loc = locations[0];
    const sourceFile = this.program.getSourceFile(loc.fileName);
    if (!sourceFile) {
      return this.errorResult("signature", "FILE_NOT_FOUND", `Source file not found`, start);
    }

    const checker = this.program.getTypeChecker();
    const node = this.findNodeAtPosition(sourceFile, loc.position);
    if (!node) {
      return this.errorResult("signature", "NO_NODE", `Could not find node at position`, start);
    }

    const symbol = checker.getSymbolAtLocation(node);
    if (!symbol) {
      return this.errorResult("signature", "NO_SYMBOL", `Could not resolve symbol`, start);
    }

    const type = checker.getTypeOfSymbolAtLocation(symbol, node);
    const typeString = checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);

    // Get detailed info based on kind
    const result: Record<string, unknown> = {
      symbol: loc.name,
      kind: loc.kind,
      defined_in: `${path.relative(this.projectRoot, loc.fileName)}:${loc.line}`,
      type: typeString,
    };

    // For functions, extract parameters and return type
    const signatures = type.getCallSignatures();
    if (signatures.length > 0) {
      const sig = signatures[0];
      result.parameters = sig.getParameters().map(p => {
        const paramType = checker.getTypeOfSymbolAtLocation(p, node);
        return {
          name: p.getName(),
          type: checker.typeToString(paramType, undefined, ts.TypeFormatFlags.NoTruncation),
          optional: (p.flags & ts.SymbolFlags.Optional) !== 0,
        };
      });
      const returnType = sig.getReturnType();
      result.return_type = checker.typeToString(returnType, undefined, ts.TypeFormatFlags.NoTruncation);

      if (sig.typeParameters && sig.typeParameters.length > 0) {
        result.type_parameters = sig.typeParameters.map(tp => tp.symbol.getName());
      }
    }

    // For interfaces/classes, list members
    const properties = type.getProperties();
    if (properties.length > 0 && signatures.length === 0) {
      result.members = properties.map(p => {
        const memberType = checker.getTypeOfSymbolAtLocation(p, node);
        return {
          name: p.getName(),
          type: checker.typeToString(memberType, undefined, ts.TypeFormatFlags.NoTruncation),
          optional: (p.flags & ts.SymbolFlags.Optional) !== 0,
        };
      });
    }

    return {
      success: true,
      operation: "signature",
      duration_ms: Date.now() - start,
      result,
      files_modified: [],
      warnings: [],
      errors: [],
    };
  }

  /**
   * Extract a range of code into a new function with correct signature.
   */
  extractFunction(
    sourceSymbol: string,
    startLine: number,
    endLine: number,
    newName: string,
  ): CodeGraphResult {
    const start = Date.now();
    const locations = this.resolveSymbol(sourceSymbol);

    if (locations.length === 0) {
      return this.errorResult("extract-function", "SYMBOL_NOT_FOUND", `No symbol '${sourceSymbol}' found`, start);
    }
    if (locations.length > 1) {
      return this.ambiguousResult("extract-function", sourceSymbol, locations, start);
    }

    const loc = locations[0];
    const sourceFile = this.program.getSourceFile(loc.fileName);
    if (!sourceFile) {
      return this.errorResult("extract-function", "FILE_NOT_FOUND", `Source file not found`, start);
    }

    const checker = this.program.getTypeChecker();

    // Get the source function declaration
    const funcNode = this.findDeclarationAtPosition(sourceFile, loc.position);
    if (!funcNode || (!ts.isFunctionDeclaration(funcNode) && !ts.isMethodDeclaration(funcNode))) {
      return this.errorResult("extract-function", "NOT_A_FUNCTION", `'${sourceSymbol}' is not a function`, start);
    }

    // Get the lines to extract (1-indexed to 0-indexed)
    const sl = startLine - 1;
    const el = endLine - 1;
    const fullText = sourceFile.getFullText();
    const lines = fullText.split("\n");

    if (sl < 0 || el >= lines.length || sl > el) {
      return this.errorResult("extract-function", "INVALID_RANGE", `Line range ${startLine}-${endLine} is invalid (file has ${lines.length} lines)`, start);
    }

    const extractedLines = lines.slice(sl, el + 1);
    const extractedText = extractedLines.join("\n");

    // Find the position range in the source
    const extractStart = sourceFile.getPositionOfLineAndCharacter(sl, 0);
    const extractEnd = el + 1 < lines.length
      ? sourceFile.getPositionOfLineAndCharacter(el + 1, 0)
      : fullText.length;

    // Analyze variables: which are used in the extracted block?
    // Walk the AST to find identifiers in the range
    const usedIdentifiers = new Set<string>();
    const assignedIdentifiers = new Set<string>();
    const declaredInBlock = new Set<string>();

    this.walkTree(funcNode, (node) => {
      if (!ts.isIdentifier(node)) return;
      const nodeStart = node.getStart();
      if (nodeStart < extractStart || nodeStart >= extractEnd) return;

      // Check if it's a variable/parameter reference
      const sym = checker.getSymbolAtLocation(node);
      if (!sym) return;

      const decls = sym.getDeclarations();
      if (!decls || decls.length === 0) return;

      const declPos = decls[0].getStart();

      // Declared inside the block
      if (declPos >= extractStart && declPos < extractEnd) {
        declaredInBlock.add(node.text);
        return;
      }

      // Declared outside the block but in the function — it's a captured variable
      const funcStart = funcNode.getStart();
      const funcEnd = funcNode.getEnd();
      if (declPos >= funcStart && declPos < funcEnd) {
        usedIdentifiers.add(node.text);

        // Check if it's being assigned
        if (node.parent && ts.isBinaryExpression(node.parent) &&
            node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            node.parent.left === node) {
          assignedIdentifiers.add(node.text);
        }
      }
    });

    // Build parameter list from captured variables
    const params: Array<{ name: string; type: string }> = [];
    for (const name of usedIdentifiers) {
      // Find the type of this variable
      const varType = this.findVariableType(funcNode, sourceFile, name, checker);
      params.push({ name, type: varType });
    }

    // Determine if the block is async (contains await)
    let isAsync = false;
    this.walkTree(funcNode, (node) => {
      const nodeStart = node.getStart();
      if (nodeStart < extractStart || nodeStart >= extractEnd) return;
      if (ts.isAwaitExpression(node)) isAsync = true;
    });

    // Determine return type — what variables declared or modified in the block
    // are used after the block?
    const returnVars: string[] = [];
    for (const name of assignedIdentifiers) {
      // Check if the variable is used after the extracted block
      this.walkTree(funcNode, (node) => {
        if (!ts.isIdentifier(node) || node.text !== name) return;
        const nodeStart = node.getStart();
        if (nodeStart >= extractEnd) {
          if (!returnVars.includes(name)) returnVars.push(name);
        }
      });
    }

    // Build the new function
    const paramStr = params.map(p => `${p.name}: ${p.type}`).join(", ");
    const asyncPrefix = isAsync ? "async " : "";

    let returnType = "void";
    let callReturnHandling = "";
    if (returnVars.length === 1) {
      const varType = this.findVariableType(funcNode, sourceFile, returnVars[0], checker);
      returnType = varType;
      callReturnHandling = `const ${returnVars[0]} = `;
    } else if (returnVars.length > 1) {
      returnType = `{ ${returnVars.map(v => `${v}: ${this.findVariableType(funcNode, sourceFile, v, checker)}`).join("; ")} }`;
      callReturnHandling = `const { ${returnVars.join(", ")} } = `;
    }

    // Detect indentation
    const firstLine = extractedLines[0];
    const indent = firstLine.match(/^(\s*)/)?.[1] ?? "  ";

    const newFunction = `${asyncPrefix}function ${newName}(${paramStr}): ${returnType} {\n${extractedText}\n${returnVars.length > 0 ? `${indent}return ${returnVars.length === 1 ? returnVars[0] : `{ ${returnVars.join(", ")} }`};\n` : ""}}`;

    const awaitPrefix = isAsync ? "await " : "";
    const callArgs = params.map(p => p.name).join(", ");
    const callExpression = `${indent}${callReturnHandling}${awaitPrefix}${newName}(${callArgs});`;

    // Apply changes
    saveRollback(this.projectRoot, "extract-function", [loc.fileName]);

    let content = fullText;
    // Replace extracted lines with function call
    content = content.substring(0, extractStart) + callExpression + "\n" + content.substring(extractEnd);

    // Insert the new function before the source function
    const funcStart = funcNode.getFullStart();
    content = content.substring(0, funcStart) + newFunction + "\n\n" + content.substring(funcStart);

    fs.writeFileSync(loc.fileName, content, "utf-8");

    return {
      success: true,
      operation: "extract-function",
      duration_ms: Date.now() - start,
      result: {
        extracted_from: loc.name,
        new_function: newName,
        parameters: params,
        return_type: returnType,
        is_async: isAsync,
        mutations: returnVars,
        lines_extracted: `${startLine}-${endLine}`,
      },
      files_modified: [path.relative(this.projectRoot, loc.fileName)],
      warnings: assignedIdentifiers.size > 0 ? [{
        code: "MUTATIONS",
        message: `Extracted block modifies: ${[...assignedIdentifiers].join(", ")}. Verify return handling is correct.`,
      }] : [],
      errors: [],
    };
  }

  /**
   * Get everything an agent needs to know about a symbol in minimal tokens.
   * Combines signature, callers, deps, and impact into one concise result.
   */
  context(symbolRef: string): CodeGraphResult {
    const start = Date.now();
    const locations = this.resolveSymbol(symbolRef);

    if (locations.length === 0) {
      return this.errorResult("context", "SYMBOL_NOT_FOUND", `No symbol '${symbolRef}' found`, start);
    }
    if (locations.length > 1) {
      return this.ambiguousResult("context", symbolRef, locations, start);
    }

    const loc = locations[0];
    const sourceFile = this.program.getSourceFile(loc.fileName);
    if (!sourceFile) {
      return this.errorResult("context", "FILE_NOT_FOUND", `Source file not found`, start);
    }

    const checker = this.program.getTypeChecker();

    // 1. Signature
    const node = this.findNodeAtPosition(sourceFile, loc.position);
    let typeString = "";
    let params: Array<{ name: string; type: string }> = [];
    let returnType = "";
    let members: Array<{ name: string; type: string }> = [];

    if (node) {
      const sym = checker.getSymbolAtLocation(node);
      if (sym) {
        const type = checker.getTypeOfSymbolAtLocation(sym, node);
        typeString = checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);

        const sigs = type.getCallSignatures();
        if (sigs.length > 0) {
          params = sigs[0].getParameters().map(p => ({
            name: p.getName(),
            type: checker.typeToString(checker.getTypeOfSymbolAtLocation(p, node), undefined, ts.TypeFormatFlags.NoTruncation),
          }));
          returnType = checker.typeToString(sigs[0].getReturnType(), undefined, ts.TypeFormatFlags.NoTruncation);
        }

        const props = type.getProperties();
        if (props.length > 0 && sigs.length === 0) {
          members = props.slice(0, 15).map(p => ({
            name: p.getName(),
            type: checker.typeToString(checker.getTypeOfSymbolAtLocation(p, node), undefined, ts.TypeFormatFlags.NoTruncation),
          }));
        }
      }
    }

    // 2. Source snippet (just the declaration, not the body)
    const declNode = this.findDeclarationAtPosition(sourceFile, loc.position);
    let snippet = "";
    if (declNode) {
      const declText = declNode.getText(sourceFile);
      // For functions, show just the signature (up to opening brace)
      const braceIdx = declText.indexOf("{");
      if (braceIdx > 0 && (loc.kind === "function" || loc.kind === "method")) {
        snippet = declText.substring(0, braceIdx).trim();
      } else if (declText.length > 300) {
        snippet = declText.substring(0, 300) + "...";
      } else {
        snippet = declText;
      }
    }

    // 3. Callers (top 5)
    const refs = this.service.findReferences(loc.fileName, loc.position);
    const callers: Array<{ file: string; line: number; text: string }> = [];
    const importedBy: string[] = [];
    let totalRefs = 0;
    const filesUsedIn = new Set<string>();

    if (refs) {
      for (const refGroup of refs) {
        for (const ref of refGroup.references) {
          if (ref.isDefinition) continue;
          const refSf = this.program.getSourceFile(ref.fileName);
          if (!refSf || refSf.isDeclarationFile) continue;
          const relPath = path.relative(this.projectRoot, ref.fileName);
          if (relPath.startsWith("..")) continue;

          totalRefs++;
          filesUsedIn.add(relPath);

          const { line } = refSf.getLineAndCharacterOfPosition(ref.textSpan.start);
          const lineText = refSf.getFullText().substring(
            refSf.getPositionOfLineAndCharacter(line, 0),
            refSf.getLineEndOfPosition(ref.textSpan.start)
          ).trim();

          if (lineText.startsWith("import") || (lineText.startsWith("export") && lineText.includes("from"))) {
            if (importedBy.length < 5) importedBy.push(relPath);
          } else if (callers.length < 5) {
            callers.push({ file: relPath, line: line + 1, text: lineText });
          }
        }
      }
    }

    // 4. Dependencies (from deps)
    const depsResult = this.deps(symbolRef);
    const dependencies = depsResult.success ? depsResult.result : {};

    // 5. Is exported?
    let isExported = false;
    const srcSymbol = checker.getSymbolAtLocation(sourceFile);
    if (srcSymbol) {
      const exps = checker.getExportsOfModule(srcSymbol);
      isExported = exps.some(e => e.getName() === loc.name);
    }

    return {
      success: true,
      operation: "context",
      duration_ms: Date.now() - start,
      result: {
        symbol: loc.name,
        kind: loc.kind,
        defined_in: `${path.relative(this.projectRoot, loc.fileName)}:${loc.line}`,
        is_exported: isExported,
        snippet,
        ...(params.length > 0 ? { parameters: params } : {}),
        ...(returnType ? { return_type: returnType } : {}),
        ...(members.length > 0 ? { members } : {}),
        usage: {
          total_references: totalRefs,
          files_used_in: filesUsedIn.size,
          top_callers: callers,
          imported_by: importedBy,
        },
        dependencies: {
          imports: (dependencies as Record<string, unknown>).imports ?? [],
          calls: (dependencies as Record<string, unknown>).calls ?? [],
          type_references: (dependencies as Record<string, unknown>).type_references ?? [],
        },
      },
      files_modified: [],
      warnings: [],
      errors: [],
    };
  }

  /**
   * Get a project overview — structure, entry points, key types, module map.
   */
  overview(): CodeGraphResult {
    const start = Date.now();
    const checker = this.program.getTypeChecker();

    // Count files per directory
    const dirCounts = new Map<string, number>();
    const allFiles: string[] = [];
    let totalLines = 0;

    for (const sf of this.program.getSourceFiles()) {
      if (sf.isDeclarationFile) continue;
      const relPath = path.relative(this.projectRoot, sf.fileName);
      if (relPath.startsWith("..") || relPath.includes("node_modules")) continue;

      allFiles.push(relPath);
      totalLines += sf.getLineAndCharacterOfPosition(sf.getEnd()).line + 1;

      const dir = path.dirname(relPath);
      dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
    }

    // Sort directories by file count
    const directories = [...dirCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([dir, count]) => ({ directory: dir, files: count }));

    // Find entry points (files with no importers, or index files)
    const entryPoints: Array<{ file: string; exports: number }> = [];
    for (const sf of this.program.getSourceFiles()) {
      if (sf.isDeclarationFile) continue;
      const relPath = path.relative(this.projectRoot, sf.fileName);
      if (relPath.startsWith("..") || relPath.includes("node_modules")) continue;

      const baseName = path.basename(relPath);
      if (baseName === "index.ts" || baseName === "index.tsx" || baseName === "main.ts" || baseName === "app.ts") {
        const fileSymbol = checker.getSymbolAtLocation(sf);
        const exportCount = fileSymbol ? checker.getExportsOfModule(fileSymbol).length : 0;
        entryPoints.push({ file: relPath, exports: exportCount });
      }
    }

    // Find key types (most referenced interfaces/types/classes)
    const typeUsage = new Map<string, { name: string; kind: string; file: string; refs: number }>();

    for (const sf of this.program.getSourceFiles()) {
      if (sf.isDeclarationFile) continue;
      const relPath = path.relative(this.projectRoot, sf.fileName);
      if (relPath.startsWith("..") || relPath.includes("node_modules")) continue;

      this.walkTree(sf, (node) => {
        if (!ts.isIdentifier(node) || !this.isDeclaration(node)) return;
        const parent = node.parent;
        if (!ts.isInterfaceDeclaration(parent) && !ts.isTypeAliasDeclaration(parent) && !ts.isClassDeclaration(parent) && !ts.isEnumDeclaration(parent)) return;

        const key = `${relPath}:${node.text}`;
        if (typeUsage.has(key)) return;

        const refs = this.service.findReferences(sf.fileName, node.getStart());
        let refCount = 0;
        if (refs) {
          for (const g of refs) {
            refCount += g.references.filter(r => !r.isDefinition).length;
          }
        }

        if (refCount > 2) {
          typeUsage.set(key, {
            name: node.text,
            kind: this.getNodeKind(parent),
            file: relPath,
            refs: refCount,
          });
        }
      });

      // Limit scanning time — stop after finding enough types
      if (typeUsage.size >= 20) break;
    }

    const keyTypes = [...typeUsage.values()]
      .sort((a, b) => b.refs - a.refs)
      .slice(0, 10);

    return {
      success: true,
      operation: "overview",
      duration_ms: Date.now() - start,
      result: {
        project_root: this.projectRoot,
        total_files: allFiles.length,
        total_lines: totalLines,
        directories,
        entry_points: entryPoints.slice(0, 10),
        key_types: keyTypes,
      },
      files_modified: [],
      warnings: [],
      errors: [],
    };
  }

  /**
   * Wrap a mutation result with auto type-check.
   * Re-initializes the program and checks for type errors introduced by the mutation.
   */
  withTypeCheck(result: CodeGraphResult): CodeGraphResult {
    if (!result.success || result.files_modified.length === 0) return result;
    if ((result.result as Record<string, unknown>).dry_run) return result;

    // Re-init to pick up file changes
    this.program = this.service.getProgram()!;
    const typeErrors = this.quickTypeCheck();

    if (typeErrors.length > 0) {
      result.warnings.push({
        code: "TYPE_ERRORS_INTRODUCED",
        message: `${typeErrors.length} type error(s) after ${result.operation}. Run 'codegraph undo' to revert.`,
      });
      (result.result as Record<string, unknown>).type_errors = typeErrors;
    } else {
      (result.result as Record<string, unknown>).type_check = "pass";
    }

    return result;
  }

  /**
   * Run type-check and return compact diagnostics for embedding in mutation results.
   */
  private quickTypeCheck(): Array<{ file: string; line: number; message: string }> {
    const diagnostics = this.program.getSemanticDiagnostics();
    const errors: Array<{ file: string; line: number; message: string }> = [];

    for (const diag of diagnostics) {
      if (diag.category !== ts.DiagnosticCategory.Error) continue;
      if (!diag.file) continue;
      const relPath = path.relative(this.projectRoot, diag.file.fileName);
      if (relPath.startsWith("..") || relPath.includes("node_modules")) continue;
      const { line } = diag.file.getLineAndCharacterOfPosition(diag.start ?? 0);
      errors.push({
        file: relPath,
        line: line + 1,
        message: ts.flattenDiagnosticMessageText(diag.messageText, "\n"),
      });
      if (errors.length >= 10) break; // cap at 10
    }
    return errors;
  }

  /**
   * Refresh the program after external file changes.
   */
  refresh(): void {
    this.program = this.service.getProgram()!;
  }

  // --- Internal helpers ---

  private findVariableType(
    scopeNode: ts.Node,
    sourceFile: ts.SourceFile,
    name: string,
    checker: ts.TypeChecker,
  ): string {
    let result = "unknown";
    this.walkTree(scopeNode, (node) => {
      if (ts.isIdentifier(node) && node.text === name) {
        const sym = checker.getSymbolAtLocation(node);
        if (sym) {
          const type = checker.getTypeOfSymbolAtLocation(sym, node);
          result = checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
        }
      }
    });
    return result;
  }

  private hasExportModifier(node: ts.Node): boolean {
    if (!ts.canHaveModifiers(node)) return false;
    const modifiers = ts.getModifiers(node);
    return modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  }

  private findNodeAtPosition(sourceFile: ts.SourceFile, position: number): ts.Node | null {
    let found: ts.Node | null = null;
    const visit = (node: ts.Node) => {
      if (found) return;
      if (node.getStart() <= position && node.getEnd() >= position) {
        found = node;
        ts.forEachChild(node, visit);
      }
    };
    visit(sourceFile);
    return found;
  }

  private findDeclarationAtPosition(sourceFile: ts.SourceFile, position: number): ts.Node | null {
    let found: ts.Node | null = null;
    const visit = (node: ts.Node) => {
      if (found) return;
      if (ts.isIdentifier(node) && node.getStart() === position) {
        found = node.parent;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return found;
  }

  private getRelativeImportPath(fromFile: string, toFile: string): string {
    const fromDir = path.dirname(fromFile);
    let rel = path.relative(fromDir, toFile);
    // Remove extension
    rel = rel.replace(/\.(ts|tsx|js|jsx)$/, "");
    // Add ./ prefix
    if (!rel.startsWith(".")) {
      rel = "./" + rel;
    }
    return rel;
  }

  private walkTree(node: ts.Node, visitor: (node: ts.Node) => void): void {
    visitor(node);
    ts.forEachChild(node, (child) => this.walkTree(child, visitor));
  }

  private isDeclaration(node: ts.Node): boolean {
    const parent = node.parent;
    if (!parent) return false;
    return (
      ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isParameter(parent)
    );
  }

  private findIdentifierInRange(sourceFile: ts.SourceFile, start: number, end: number): ts.Identifier | null {
    let found: ts.Identifier | null = null;
    const visit = (node: ts.Node) => {
      if (found) return;
      if (node.getStart() >= start && node.getEnd() <= end && ts.isIdentifier(node)) {
        found = node;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return found;
  }

  private getNodeKind(node: ts.Node): string {
    if (ts.isFunctionDeclaration(node)) return "function";
    if (ts.isClassDeclaration(node)) return "class";
    if (ts.isInterfaceDeclaration(node)) return "interface";
    if (ts.isTypeAliasDeclaration(node)) return "type_alias";
    if (ts.isEnumDeclaration(node)) return "enum";
    if (ts.isVariableDeclaration(node)) return "variable";
    if (ts.isMethodDeclaration(node)) return "method";
    if (ts.isPropertyDeclaration(node)) return "property";
    if (ts.isPropertySignature(node)) return "property";
    if (ts.isParameter(node)) return "parameter";
    return "unknown";
  }

  private errorResult(operation: string, code: string, message: string, startTime: number): CodeGraphResult {
    return {
      success: false,
      operation,
      duration_ms: Date.now() - startTime,
      result: {},
      files_modified: [],
      warnings: [],
      errors: [{ code, message }],
    };
  }

  private ambiguousResult(operation: string, symbolRef: string, locations: SymbolLocation[], startTime: number): CodeGraphResult {
    return {
      success: false,
      operation,
      duration_ms: Date.now() - startTime,
      result: {
        candidates: locations.map(l => ({
          symbol: l.name,
          kind: l.kind,
          file: path.relative(this.projectRoot, l.fileName),
          line: l.line,
        })),
      },
      files_modified: [],
      warnings: [],
      errors: [{
        code: "AMBIGUOUS_SYMBOL",
        message: `Multiple symbols match '${symbolRef}'. Use file:line to specify.`,
      }],
    };
  }
}
