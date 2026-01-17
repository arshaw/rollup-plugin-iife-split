import MagicString from 'magic-string';
import { walk } from 'estree-walker';
import type { OutputChunk } from 'rollup';
import type { Node, ExportNamedDeclaration, ExportDefaultDeclaration, Identifier, Program, VariableDeclaration, FunctionDeclaration, ClassDeclaration } from 'estree';
import { SHARED_CHUNK_NAME } from './chunk-analyzer';
import type { ParseFn } from './types';

interface ExportMapping {
  exportedName: string;
  localName: string;
}

interface ExportInfo {
  exports: ExportMapping[];
  hasDefault: boolean;
}

/**
 * Extracts all top-level declaration names from code.
 * This includes variables, functions, and classes at the module scope.
 */
function extractTopLevelDeclarations(code: string, parse: ParseFn): Set<string> {
  const ast = parse(code);

  const declarations = new Set<string>();

  for (const node of ast.body) {
    // Handle: const x, let x, var x
    if (node.type === 'VariableDeclaration') {
      const varDecl = node as VariableDeclaration;
      for (const decl of varDecl.declarations) {
        if (decl.id.type === 'Identifier') {
          declarations.add(decl.id.name);
        }
      }
    }
    // Handle: function x() {}
    else if (node.type === 'FunctionDeclaration') {
      const funcDecl = node as FunctionDeclaration;
      if (funcDecl.id) {
        declarations.add(funcDecl.id.name);
      }
    }
    // Handle: class X {}
    else if (node.type === 'ClassDeclaration') {
      const classDecl = node as ClassDeclaration;
      if (classDecl.id) {
        declarations.add(classDecl.id.name);
      }
    }
    // Handle: export const x, export function x, export class X
    else if (node.type === 'ExportNamedDeclaration') {
      const exportNode = node as ExportNamedDeclaration;
      if (exportNode.declaration) {
        if (exportNode.declaration.type === 'VariableDeclaration') {
          for (const decl of exportNode.declaration.declarations) {
            if (decl.id.type === 'Identifier') {
              declarations.add(decl.id.name);
            }
          }
        } else if (exportNode.declaration.type === 'FunctionDeclaration' && exportNode.declaration.id) {
          declarations.add(exportNode.declaration.id.name);
        } else if (exportNode.declaration.type === 'ClassDeclaration' && exportNode.declaration.id) {
          declarations.add(exportNode.declaration.id.name);
        }
      }
    }
  }

  return declarations;
}

/**
 * Renames identifiers in code based on a rename map.
 * Handles all identifier references, not just declarations.
 */
function renameIdentifiers(code: string, renameMap: Map<string, string>, parse: ParseFn): string {
  if (renameMap.size === 0) return code;

  const ast = parse(code) as Node;

  const s = new MagicString(code);

  walk(ast, {
    enter(node) {
      if (node.type === 'Identifier') {
        const id = node as Identifier & { start: number; end: number };
        const newName = renameMap.get(id.name);
        if (newName) {
          s.overwrite(id.start, id.end, newName);
        }
      }
    }
  });

  return s.toString();
}

function extractExports(code: string, parse: ParseFn): ExportInfo {
  const ast = parse(code) as Node;

  const exports: ExportMapping[] = [];
  let hasDefault = false;

  walk(ast, {
    enter(node) {
      if (node.type === 'ExportNamedDeclaration') {
        const exportNode = node as ExportNamedDeclaration;
        if (exportNode.declaration) {
          // export const foo = ... / export function foo() {}
          if (exportNode.declaration.type === 'VariableDeclaration') {
            for (const decl of exportNode.declaration.declarations) {
              if (decl.id.type === 'Identifier') {
                exports.push({ exportedName: decl.id.name, localName: decl.id.name });
              }
            }
          } else if (
            exportNode.declaration.type === 'FunctionDeclaration' &&
            exportNode.declaration.id
          ) {
            const name = exportNode.declaration.id.name;
            exports.push({ exportedName: name, localName: name });
          } else if (
            exportNode.declaration.type === 'ClassDeclaration' &&
            exportNode.declaration.id
          ) {
            const name = exportNode.declaration.id.name;
            exports.push({ exportedName: name, localName: name });
          }
        }
        // export { foo, bar } or export { foo as bar }
        if (exportNode.specifiers) {
          for (const spec of exportNode.specifiers) {
            const exported = spec.exported as Identifier;
            const local = spec.local as Identifier;
            exports.push({ exportedName: exported.name, localName: local.name });
          }
        }
      }
      if (node.type === 'ExportDefaultDeclaration') {
        hasDefault = true;
      }
    }
  });

  return { exports, hasDefault };
}

function stripExports(code: string, parse: ParseFn): string {
  const ast = parse(code) as Node;

  const s = new MagicString(code);

  walk(ast, {
    enter(node) {
      const n = node as Node & { start: number; end: number };
      if (node.type === 'ExportNamedDeclaration') {
        const exportNode = node as ExportNamedDeclaration & { start: number; end: number };
        if (exportNode.declaration) {
          // export const foo -> const foo
          const declNode = exportNode.declaration as Node & { start: number };
          s.remove(exportNode.start, declNode.start);
        } else {
          // export { foo } -> remove entirely
          s.remove(n.start, n.end);
        }
      }
      if (node.type === 'ExportDefaultDeclaration') {
        const exportNode = node as ExportDefaultDeclaration & { start: number };
        const declNode = exportNode.declaration as Node & { start: number };
        // export default X -> const __default__ = X
        s.overwrite(exportNode.start, declNode.start, 'const __shared_default__ = ');
      }
    }
  });

  return s.toString();
}

/**
 * Checks if an import source refers to the shared chunk.
 */
function isSharedChunkSource(source: string, sharedChunkFileName: string): boolean {
  return (
    source.includes(SHARED_CHUNK_NAME) ||
    source.includes(sharedChunkFileName.replace(/\.js$/, ''))
  );
}

interface ImportInfo {
  type: 'namespace' | 'named' | 'default';
  localName: string;
  importedName?: string; // For named imports: the original name being imported
}

/**
 * Removes shared chunk imports from primary code and rewrites all references.
 *
 * Handles:
 * 1. Namespace imports: `import * as shared from './__shared__.js'`
 *    - Removes the import
 *    - Rewrites `shared.foo` -> `foo`
 * 2. Named imports: `import { foo, bar as baz } from './__shared__.js'`
 *    - Removes the import (the names become local from merged shared code)
 * 3. Re-exports: `export { foo } from './__shared__.js'`
 *    - Converts to `export { foo }` (removes the source)
 */
function removeSharedImportsAndRewriteRefs(
  code: string,
  sharedChunkFileName: string,
  sharedExportToLocal: Map<string, string>,
  parse: ParseFn
): string {
  const ast = parse(code) as Node;

  const s = new MagicString(code);

  // First pass: find namespace import names for the shared chunk
  const namespaceNames = new Set<string>();

  walk(ast, {
    enter(node) {
      if (node.type === 'ImportDeclaration') {
        const importNode = node as Node & {
          start: number;
          end: number;
          source: { value: unknown };
          specifiers: Array<{
            type: string;
            local: Identifier & { start: number; end: number };
            imported?: Identifier;
          }>;
        };
        const source = importNode.source.value;
        if (typeof source === 'string' && isSharedChunkSource(source, sharedChunkFileName)) {
          for (const spec of importNode.specifiers) {
            if (spec.type === 'ImportNamespaceSpecifier') {
              namespaceNames.add(spec.local.name);
            }
          }
        }
      }
    }
  });

  // Second pass: remove imports, rewrite member expressions, handle re-exports
  walk(ast, {
    enter(node) {
      // Remove import declarations from shared chunk
      if (node.type === 'ImportDeclaration') {
        const importNode = node as Node & { start: number; end: number; source: { value: unknown } };
        const source = importNode.source.value;
        if (typeof source === 'string' && isSharedChunkSource(source, sharedChunkFileName)) {
          s.remove(importNode.start, importNode.end);
        }
      }

      // Handle re-exports: export { foo } from './__shared__.js'
      // Convert to: export { localName as foo }
      if (node.type === 'ExportNamedDeclaration') {
        const exportNode = node as ExportNamedDeclaration & {
          start: number;
          end: number;
          source?: { value: unknown; start: number; end: number } | null;
          specifiers: Array<{
            type: string;
            local: Identifier & { start: number; end: number };
            exported: Identifier & { start: number; end: number };
          }>;
        };

        if (exportNode.source) {
          const source = exportNode.source.value;
          if (typeof source === 'string' && isSharedChunkSource(source, sharedChunkFileName)) {
            // This is a re-export from the shared chunk
            // We need to rewrite it to export the local names
            const exportParts: string[] = [];
            for (const spec of exportNode.specifiers) {
              const exportedName = spec.exported.name;
              // The 'local' in a re-export is actually the imported name from the source
              const importedName = spec.local.name;
              // Look up the local name in the merged shared code
              const localName = sharedExportToLocal.get(importedName) ?? importedName;

              if (localName === exportedName) {
                exportParts.push(localName);
              } else {
                exportParts.push(`${localName} as ${exportedName}`);
              }
            }
            // Replace the entire export statement
            s.overwrite(exportNode.start, exportNode.end, `export { ${exportParts.join(', ')} };`);
          }
        }
      }

      // Rewrite namespace member access: __shared__.foo -> foo
      if (node.type === 'MemberExpression') {
        const memberNode = node as Node & {
          start: number;
          end: number;
          object: { type: string; name?: string; start: number; end: number };
          property: { type: string; name?: string; start: number; end: number };
          computed: boolean;
        };

        if (
          memberNode.object.type === 'Identifier' &&
          memberNode.object.name &&
          namespaceNames.has(memberNode.object.name) &&
          memberNode.property.type === 'Identifier' &&
          memberNode.property.name &&
          !memberNode.computed
        ) {
          const propertyName = memberNode.property.name;
          // Look up the local name in the merged shared code
          const localName = sharedExportToLocal.get(propertyName) ?? propertyName;
          // Replace `namespace.property` with just `localName`
          s.overwrite(memberNode.start, memberNode.end, localName);
        }
      }
    }
  });

  return s.toString();
}

/**
 * Extracts which exports from the shared chunk are imported by this code.
 * Returns a set of imported names (the names exported from shared, not local aliases).
 */
export function extractSharedImports(code: string, sharedChunkFileName: string, parse: ParseFn): Set<string> {
  const ast = parse(code) as Node;

  const imports = new Set<string>();

  walk(ast, {
    enter(node) {
      if (node.type === 'ImportDeclaration') {
        const importNode = node as Node & {
          source: { value: unknown };
          specifiers: Array<{
            type: string;
            local: Identifier;
            imported?: Identifier;
          }>;
        };
        const source = importNode.source.value;
        if (typeof source === 'string' && isSharedChunkSource(source, sharedChunkFileName)) {
          for (const spec of importNode.specifiers) {
            if (spec.type === 'ImportSpecifier' && spec.imported) {
              imports.add(spec.imported.name);
            } else if (spec.type === 'ImportDefaultSpecifier') {
              imports.add('default');
            } else if (spec.type === 'ImportNamespaceSpecifier') {
              // Namespace import - we'll need to analyze member accesses
              // For now, mark as needing all exports (conservative)
              // A more sophisticated approach would analyze MemberExpressions
            }
          }
        }
      }
    }
  });

  return imports;
}

/**
 * Checks if an import source refers to a specific chunk.
 */
function isChunkSource(source: string, chunkFileName: string): boolean {
  // The import path might be './chunk-name.js' or './chunk-name'
  const baseName = chunkFileName.replace(/\.js$/, '');
  return source.includes(baseName);
}

/**
 * Removes imports from a specific chunk and rewrites all references.
 * Handles both namespace imports and named imports with aliasing.
 *
 * For named imports like `import { messages as m }`, all references to `m`
 * are rewritten to the actual local name from the merged code.
 *
 * Returns the modified code with imports removed and references resolved.
 */
function removeChunkImportsAndRewriteRefs(
  code: string,
  chunkFileName: string,
  exportToLocal: Map<string, string>,
  parse: ParseFn
): string {
  const ast = parse(code) as Node;
  const s = new MagicString(code);

  // Maps for rewriting references
  const namespaceNames = new Set<string>();
  // Map from local alias name → actual local name in merged code
  const namedImportRenames = new Map<string, string>();

  // First pass: collect import info and build rename maps
  walk(ast, {
    enter(node) {
      if (node.type === 'ImportDeclaration') {
        const importNode = node as Node & {
          source: { value: unknown };
          specifiers: Array<{
            type: string;
            local: Identifier & { start: number; end: number };
            imported?: Identifier;
          }>;
        };
        const source = importNode.source.value;
        if (typeof source === 'string' && isChunkSource(source, chunkFileName)) {
          for (const spec of importNode.specifiers) {
            if (spec.type === 'ImportNamespaceSpecifier') {
              namespaceNames.add(spec.local.name);
            } else if (spec.type === 'ImportSpecifier' && spec.imported) {
              // Named import: import { exportedName as localAlias }
              // The local alias should be renamed to the actual local name
              const exportedName = spec.imported.name;
              const localAlias = spec.local.name;
              const actualLocal = exportToLocal.get(exportedName) ?? exportedName;

              // Only add to rename map if they're different
              if (localAlias !== actualLocal) {
                namedImportRenames.set(localAlias, actualLocal);
              }
            } else if (spec.type === 'ImportDefaultSpecifier') {
              // Default import: import foo from '...'
              const localAlias = spec.local.name;
              const actualLocal = exportToLocal.get('default') ?? '__default__';

              if (localAlias !== actualLocal) {
                namedImportRenames.set(localAlias, actualLocal);
              }
            }
          }
        }
      }
    }
  });

  // Second pass: remove imports and rewrite references
  walk(ast, {
    enter(node) {
      // Remove import declarations from the chunk
      if (node.type === 'ImportDeclaration') {
        const importNode = node as Node & { start: number; end: number; source: { value: unknown } };
        const source = importNode.source.value;
        if (typeof source === 'string' && isChunkSource(source, chunkFileName)) {
          s.remove(importNode.start, importNode.end);
        }
      }

      // Rewrite namespace member access: namespace.foo -> localFoo
      if (node.type === 'MemberExpression') {
        const memberNode = node as Node & {
          start: number;
          end: number;
          object: { type: string; name?: string };
          property: { type: string; name?: string };
          computed: boolean;
        };

        if (
          memberNode.object.type === 'Identifier' &&
          memberNode.object.name &&
          namespaceNames.has(memberNode.object.name) &&
          memberNode.property.type === 'Identifier' &&
          memberNode.property.name &&
          !memberNode.computed
        ) {
          const propertyName = memberNode.property.name;
          const localName = exportToLocal.get(propertyName) ?? propertyName;
          s.overwrite(memberNode.start, memberNode.end, localName);
        }
      }

      // Rewrite named import references: oldAlias -> newLocalName
      if (node.type === 'Identifier' && namedImportRenames.size > 0) {
        const id = node as Identifier & { start: number; end: number };
        const newName = namedImportRenames.get(id.name);
        if (newName) {
          s.overwrite(id.start, id.end, newName);
        }
      }
    }
  });

  return s.toString();
}

/**
 * Checks if a chunk imports from another chunk.
 */
export function chunkImportsFrom(chunk: OutputChunk, sourceChunkFileName: string): boolean {
  // Check the imports array which lists files this chunk imports from
  return chunk.imports.some(imp => isChunkSource(imp, sourceChunkFileName));
}

/**
 * Merges an unshared chunk into all entry chunks that import from it.
 *
 * Unlike shared chunks (which are merged only into primary and exposed globally),
 * unshared chunks are duplicated into each importing entry. The exports become
 * local declarations in each entry.
 *
 * @param unsharedChunk The chunk to be inlined
 * @param entryChunks All entry chunks (primary + satellites)
 * @param parse Parser function
 */
export function mergeUnsharedIntoImporters(
  unsharedChunk: OutputChunk,
  entryChunks: OutputChunk[],
  parse: ParseFn,
  debug?: boolean
): void {
  // Extract exports from the unshared chunk
  const { exports: unsharedExports, hasDefault } = extractExports(unsharedChunk.code, parse);

  // Build export-to-local mapping
  const exportToLocal = new Map<string, string>();
  for (const exp of unsharedExports) {
    exportToLocal.set(exp.exportedName, exp.localName);
  }
  if (hasDefault) {
    exportToLocal.set('default', '__unshared_default__');
  }

  // Strip exports from unshared code (convert to plain declarations)
  let strippedCode = stripExports(unsharedChunk.code, parse);

  // Handle default export naming
  if (hasDefault) {
    // stripExports already converts `export default X` to `const __shared_default__ = X`
    // We need to update this to our unshared-specific name
    strippedCode = strippedCode.replace(
      /const __shared_default__ = /g,
      'const __unshared_default__ = '
    );
  }

  // Merge into each importing entry
  for (const entry of entryChunks) {
    if (!chunkImportsFrom(entry, unsharedChunk.fileName)) {
      continue;
    }

    // Always rename inlined declarations to avoid conflicts with:
    // 1. Existing entry declarations
    // 2. Import aliases from other unshared chunks that will be merged later
    // Using a unique prefix based on chunk name ensures no conflicts
    const unsharedDeclarations = extractTopLevelDeclarations(unsharedChunk.code, parse);
    const suffix = unsharedChunk.name.replace(/[^a-zA-Z0-9]/g, '_');

    // Rename ALL declarations from the unshared chunk to unique names
    const renameMap = new Map<string, string>();
    for (const name of unsharedDeclarations) {
      const newName = `__${suffix}$${name}`;
      renameMap.set(name, newName);
    }

    // Rename identifiers in the stripped code
    let codeToInline = strippedCode;
    codeToInline = renameIdentifiers(codeToInline, renameMap, parse);

    // Update exportToLocal with renames
    const localExportToLocal = new Map<string, string>();
    for (const [exportName, localName] of exportToLocal) {
      const renamed = renameMap.get(localName) ?? localName;
      localExportToLocal.set(exportName, renamed);
    }

    // Remove imports from the unshared chunk and rewrite references
    const entryWithoutImports = removeChunkImportsAndRewriteRefs(
      entry.code,
      unsharedChunk.fileName,
      localExportToLocal,
      parse
    );

    // Combine: inlined code + entry code
    entry.code = [
      debug && `// === Inlined from ${unsharedChunk.name} (duplicated by rollup-plugin-iife-split) ===`,
      codeToInline.trim(),
      '',
      debug && '// === Entry code ===',
      entryWithoutImports.trim()
    ].filter(line => line !== false).join('\n');
  }
}

export function mergeSharedIntoPrimary(
  primaryChunk: OutputChunk,
  sharedChunk: OutputChunk,
  sharedProperty: string,
  neededExports: Set<string>,
  parse: ParseFn,
  debug?: boolean
): void {
  // Extract export information BEFORE renaming to preserve original exported names
  const { exports: sharedExports, hasDefault } = extractExports(sharedChunk.code, parse);

  // Extract declarations from both chunks to detect collisions
  const sharedDeclarations = extractTopLevelDeclarations(sharedChunk.code, parse);
  const primaryDeclarations = extractTopLevelDeclarations(primaryChunk.code, parse);

  // Find collisions and build rename map
  const renameMap = new Map<string, string>();
  for (const name of sharedDeclarations) {
    if (primaryDeclarations.has(name)) {
      // Collision detected - rename the shared symbol
      renameMap.set(name, `__shared$${name}`);
    }
  }

  // Rename colliding identifiers in the shared code
  let processedSharedCode = sharedChunk.code;
  if (renameMap.size > 0) {
    processedSharedCode = renameIdentifiers(processedSharedCode, renameMap, parse);
  }

  // Strip exports from shared code (convert to plain declarations)
  const strippedSharedCode = stripExports(processedSharedCode, parse);

  // Build a map from shared export names to their local names (after collision renames)
  // This is used to rewrite references in the primary code
  const sharedExportToLocal = new Map<string, string>();
  for (const exp of sharedExports) {
    const renamedLocal = renameMap.get(exp.localName) ?? exp.localName;
    // Map the exported name to the local name (which may have been renamed)
    sharedExportToLocal.set(exp.exportedName, renamedLocal);
  }
  if (hasDefault) {
    sharedExportToLocal.set('default', '__shared_default__');
  }

  // Remove shared chunk imports from primary and rewrite all references
  const primaryWithoutSharedImports = removeSharedImportsAndRewriteRefs(
    primaryChunk.code,
    sharedChunk.fileName,
    sharedExportToLocal,
    parse
  );

  // Build the shared exports object using exportedName: localName format
  // Only include exports that are actually needed by satellites
  // Apply rename map to localNames to reflect collision renames
  const sharedExportEntries = [
    ...sharedExports
      .filter(exp => neededExports.has(exp.exportedName))
      .map(exp => {
        const renamedLocal = renameMap.get(exp.localName) ?? exp.localName;
        return exp.exportedName === renamedLocal
          ? renamedLocal
          : `${exp.exportedName}: ${renamedLocal}`;
      }),
    ...(hasDefault && neededExports.has('default') ? ['default: __shared_default__'] : [])
  ];

  const sharedExportObject = `const ${sharedProperty} = { ${sharedExportEntries.join(', ')} };`;

  // Combine: shared code + primary code + shared exports
  primaryChunk.code = [
    debug && '// === Shared code (merged by rollup-plugin-iife-split) ===',
    strippedSharedCode.trim(),
    '',
    debug && '// === Primary entry code ===',
    primaryWithoutSharedImports.trim(),
    '',
    debug && '// === Shared exports object ===',
    sharedExportObject,
    `export { ${sharedProperty} };`
  ].filter(line => line !== false).join('\n');
}
