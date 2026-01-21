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
 * Extracts all local binding names from external (non-relative) imports.
 * These represent names that will be in scope after the shared chunk is merged.
 */
function extractExternalImportBindings(code: string, parse: ParseFn): Set<string> {
  const ast = parse(code);
  const bindings = new Set<string>();

  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration') {
      const importNode = node as Node & {
        source: { value: unknown };
        specifiers: Array<{
          type: string;
          local: Identifier;
        }>;
      };
      const source = importNode.source.value;
      // Only consider external imports (not relative paths)
      if (typeof source === 'string' && !source.startsWith('.') && !source.startsWith('/')) {
        for (const spec of importNode.specifiers) {
          bindings.add(spec.local.name);
        }
      }
    }
  }

  return bindings;
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
      // Special handling for named import specifiers - need to rewrite as "importedName as newLocalName"
      // because the imported name must stay the same (it's the name exported by the module)
      if (node.type === 'ImportSpecifier') {
        const spec = node as {
          start: number;
          end: number;
          imported: Identifier & { start: number; end: number };
          local: Identifier & { start: number; end: number };
        };

        const newName = renameMap.get(spec.local.name);
        if (newName) {
          const importedName = spec.imported.name;
          s.overwrite(spec.start, spec.end, `${importedName} as ${newName}`);
        }
        this.skip(); // Don't walk to children (imported/local identifiers)
        return;
      }

      // Special handling for default imports - need to convert to named import syntax
      // import foo from 'pkg' → import { default as newFoo } from 'pkg'
      if (node.type === 'ImportDefaultSpecifier') {
        const spec = node as {
          start: number;
          end: number;
          local: Identifier & { start: number; end: number };
        };

        const newName = renameMap.get(spec.local.name);
        if (newName) {
          s.overwrite(spec.start, spec.end, `{ default as ${newName} }`);
        }
        this.skip();
        return;
      }

      // Special handling for namespace imports - just rename the local binding
      // import * as foo from 'pkg' → import * as newFoo from 'pkg'
      if (node.type === 'ImportNamespaceSpecifier') {
        const spec = node as {
          start: number;
          end: number;
          local: Identifier & { start: number; end: number };
        };

        const newName = renameMap.get(spec.local.name);
        if (newName) {
          s.overwrite(spec.start, spec.end, `* as ${newName}`);
        }
        this.skip();
        return;
      }

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

interface ExternalImport {
  source: string;
  specifiers: Array<{
    type: 'default' | 'namespace' | 'named';
    localName: string;
    importedName?: string; // For named imports
  }>;
  fullStatement: string;
  start: number;
  end: number;
}

/**
 * Extracts all external (non-relative) imports from code.
 * Returns information about each import for deduplication purposes.
 */
function extractExternalImports(code: string, parse: ParseFn): ExternalImport[] {
  const ast = parse(code) as Node;
  const imports: ExternalImport[] = [];

  walk(ast, {
    enter(node) {
      if (node.type === 'ImportDeclaration') {
        const importNode = node as Node & {
          start: number;
          end: number;
          source: { value: unknown };
          specifiers: Array<{
            type: string;
            local: Identifier;
            imported?: Identifier;
          }>;
        };
        const source = importNode.source.value;
        if (typeof source === 'string' && !source.startsWith('.') && !source.startsWith('/')) {
          // This is an external import (not relative)
          const specifiers: ExternalImport['specifiers'] = [];
          for (const spec of importNode.specifiers) {
            if (spec.type === 'ImportDefaultSpecifier') {
              specifiers.push({ type: 'default', localName: spec.local.name });
            } else if (spec.type === 'ImportNamespaceSpecifier') {
              specifiers.push({ type: 'namespace', localName: spec.local.name });
            } else if (spec.type === 'ImportSpecifier' && spec.imported) {
              specifiers.push({
                type: 'named',
                localName: spec.local.name,
                importedName: spec.imported.name
              });
            }
          }
          imports.push({
            source,
            specifiers,
            fullStatement: code.slice(importNode.start, importNode.end),
            start: importNode.start,
            end: importNode.end
          });
        }
      }
    }
  });

  return imports;
}

/**
 * Removes specific external imports from code based on source and specifier matching.
 * Returns the modified code and a map of any local name remappings needed.
 *
 * When the same symbol is imported with different local names in primary vs shared,
 * the shared code's references need to be rewritten to use the primary's local name.
 */
function removeOrRewriteDuplicateExternalImports(
  sharedCode: string,
  primaryImports: ExternalImport[],
  parse: ParseFn
): { code: string; renameMap: Map<string, string> } {
  const sharedImports = extractExternalImports(sharedCode, parse);
  const s = new MagicString(sharedCode);
  const renameMap = new Map<string, string>();

  // Build a lookup of primary imports by source
  const primaryBySource = new Map<string, ExternalImport[]>();
  for (const imp of primaryImports) {
    const existing = primaryBySource.get(imp.source) || [];
    existing.push(imp);
    primaryBySource.set(imp.source, existing);
  }

  for (const sharedImp of sharedImports) {
    const primaryImpsForSource = primaryBySource.get(sharedImp.source);
    if (!primaryImpsForSource) continue;

    // Check each specifier in the shared import
    const specifiersToKeep: typeof sharedImp.specifiers = [];

    for (const sharedSpec of sharedImp.specifiers) {
      let foundInPrimary = false;

      for (const primaryImp of primaryImpsForSource) {
        for (const primarySpec of primaryImp.specifiers) {
          // Check if same type and same imported symbol
          if (sharedSpec.type === primarySpec.type) {
            if (sharedSpec.type === 'named' && primarySpec.type === 'named') {
              if (sharedSpec.importedName === primarySpec.importedName) {
                foundInPrimary = true;
                // If local names differ, we need to rename shared's references
                if (sharedSpec.localName !== primarySpec.localName) {
                  renameMap.set(sharedSpec.localName, primarySpec.localName);
                }
                break;
              }
            } else if (sharedSpec.type === 'default' && primarySpec.type === 'default') {
              foundInPrimary = true;
              if (sharedSpec.localName !== primarySpec.localName) {
                renameMap.set(sharedSpec.localName, primarySpec.localName);
              }
              break;
            } else if (sharedSpec.type === 'namespace' && primarySpec.type === 'namespace') {
              foundInPrimary = true;
              if (sharedSpec.localName !== primarySpec.localName) {
                renameMap.set(sharedSpec.localName, primarySpec.localName);
              }
              break;
            }
          }
        }
        if (foundInPrimary) break;
      }

      if (!foundInPrimary) {
        specifiersToKeep.push(sharedSpec);
      }
    }

    // If all specifiers were found in primary, remove the entire import
    if (specifiersToKeep.length === 0) {
      s.remove(sharedImp.start, sharedImp.end);
    } else if (specifiersToKeep.length < sharedImp.specifiers.length) {
      // Some specifiers need to be kept - rebuild the import statement
      const parts: string[] = [];
      const namedParts: string[] = [];

      for (const spec of specifiersToKeep) {
        if (spec.type === 'default') {
          parts.unshift(spec.localName);
        } else if (spec.type === 'namespace') {
          parts.push(`* as ${spec.localName}`);
        } else if (spec.type === 'named') {
          if (spec.importedName === spec.localName) {
            namedParts.push(spec.localName);
          } else {
            namedParts.push(`${spec.importedName} as ${spec.localName}`);
          }
        }
      }

      if (namedParts.length > 0) {
        parts.push(`{ ${namedParts.join(', ')} }`);
      }

      const newImport = `import ${parts.join(', ')} from '${sharedImp.source}';`;
      s.overwrite(sharedImp.start, sharedImp.end, newImport);
    }
  }

  return { code: s.toString(), renameMap };
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
 *    - Removes the import
 *    - Rewrites `baz` -> local name from merged shared code
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

  // First pass: collect import info from shared chunk
  const namespaceNames = new Set<string>();
  // Map from local alias (e.g., 'Calendar$1') to actual local name in merged code (e.g., 'Calendar')
  const namedImportRenames = new Map<string, string>();

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
            } else if (spec.type === 'ImportSpecifier' && spec.imported) {
              // Named import: import { exportedName as localAlias }
              const exportedName = spec.imported.name;
              const localAlias = spec.local.name;
              // Look up what the local name is in the merged shared code
              const actualLocal = sharedExportToLocal.get(exportedName) ?? exportedName;
              // Only add to rename map if they're different
              if (localAlias !== actualLocal) {
                namedImportRenames.set(localAlias, actualLocal);
              }
            } else if (spec.type === 'ImportDefaultSpecifier') {
              // Default import: import foo from '...'
              const localAlias = spec.local.name;
              const actualLocal = sharedExportToLocal.get('default') ?? '__shared_default__';
              if (localAlias !== actualLocal) {
                namedImportRenames.set(localAlias, actualLocal);
              }
            }
          }
        }
      }
    }
  });

  // Second pass: remove imports, rewrite references, handle re-exports
  walk(ast, {
    enter(node) {
      // Remove import declarations from shared chunk
      if (node.type === 'ImportDeclaration') {
        const importNode = node as Node & { start: number; end: number; source: { value: unknown } };
        const source = importNode.source.value;
        if (typeof source === 'string' && isSharedChunkSource(source, sharedChunkFileName)) {
          s.remove(importNode.start, importNode.end);
          this.skip(); // Don't process children - we've removed the whole node
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
            this.skip(); // Don't process children - we've replaced the whole node
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
          this.skip(); // Don't process children - we've replaced the whole expression
        }
      }

      // Rewrite named import references: Calendar$1 -> Calendar
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
  parse: ParseFn
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
    entry.code = `${codeToInline.trim()}\n\n${entryWithoutImports.trim()}`;
  }
}

export function mergeSharedIntoPrimary(
  primaryChunk: OutputChunk,
  sharedChunk: OutputChunk,
  sharedProperty: string,
  neededExports: Set<string>,
  parse: ParseFn
): void {
  // Extract export information BEFORE renaming to preserve original exported names
  const { exports: sharedExports, hasDefault } = extractExports(sharedChunk.code, parse);

  // Deduplicate external imports: remove from PRIMARY any that already exist in SHARED.
  // Since shared code is prepended before primary code in the final output,
  // we keep the imports in shared (which appears first) and remove duplicates from primary.
  const sharedExternalImports = extractExternalImports(sharedChunk.code, parse);
  const { code: primaryCodeDeduped, renameMap: externalRenameMap } =
    removeOrRewriteDuplicateExternalImports(primaryChunk.code, sharedExternalImports, parse);

  // Extract declarations from both chunks to detect collisions
  const sharedDeclarations = extractTopLevelDeclarations(sharedChunk.code, parse);
  const primaryDeclarations = extractTopLevelDeclarations(primaryCodeDeduped, parse);

  // Also extract external import bindings from primary - these are names that will
  // be in scope and could collide with shared declarations
  const primaryExternalBindings = extractExternalImportBindings(primaryCodeDeduped, parse);

  // Also extract external import bindings from shared - these could collide with primary declarations
  const sharedExternalBindings = extractExternalImportBindings(sharedChunk.code, parse);

  // Find collisions between shared declarations and primary declarations/imports
  const collisionRenameMap = new Map<string, string>();
  for (const name of sharedDeclarations) {
    if (primaryDeclarations.has(name) || primaryExternalBindings.has(name)) {
      // Collision detected - rename the shared symbol
      collisionRenameMap.set(name, `__shared$${name}`);
    }
  }

  // Also check shared import bindings vs primary declarations and primary import bindings
  // (the latter handles cases where both import different packages with the same local name)
  for (const name of sharedExternalBindings) {
    if ((primaryDeclarations.has(name) || primaryExternalBindings.has(name)) && !collisionRenameMap.has(name)) {
      // Collision detected - rename the shared import binding
      collisionRenameMap.set(name, `__shared$${name}`);
    }
  }

  // Rename colliding identifiers in the shared code
  let processedSharedCode = sharedChunk.code;
  if (collisionRenameMap.size > 0) {
    processedSharedCode = renameIdentifiers(processedSharedCode, collisionRenameMap, parse);
  }

  // Strip exports from shared code (convert to plain declarations)
  const strippedSharedCode = stripExports(processedSharedCode, parse);

  // Build a map from shared export names to their local names (after collision renames)
  // This is used to rewrite references in the primary code
  const sharedExportToLocal = new Map<string, string>();
  for (const exp of sharedExports) {
    const renamedLocal = collisionRenameMap.get(exp.localName) ?? exp.localName;
    // Map the exported name to the local name (which may have been renamed)
    sharedExportToLocal.set(exp.exportedName, renamedLocal);
  }
  if (hasDefault) {
    sharedExportToLocal.set('default', '__shared_default__');
  }

  // Remove shared chunk imports from primary and rewrite all references
  // Start with the deduped primary code (external duplicates already removed)
  let primaryWithoutSharedImports = removeSharedImportsAndRewriteRefs(
    primaryCodeDeduped,
    sharedChunk.fileName,
    sharedExportToLocal,
    parse
  );

  // Apply external rename map to primary code if needed
  // (when shared and primary imported the same symbol with different local names)
  if (externalRenameMap.size > 0) {
    primaryWithoutSharedImports = renameIdentifiers(primaryWithoutSharedImports, externalRenameMap, parse);
  }

  // Build the shared exports object using exportedName: localName format
  // Only include exports that are actually needed by satellites
  // Apply collision rename map to localNames to reflect collision renames
  const sharedExportEntries = [
    ...sharedExports
      .filter(exp => neededExports.has(exp.exportedName))
      .map(exp => {
        const renamedLocal = collisionRenameMap.get(exp.localName) ?? exp.localName;
        return exp.exportedName === renamedLocal
          ? renamedLocal
          : `${exp.exportedName}: ${renamedLocal}`;
      }),
    ...(hasDefault && neededExports.has('default') ? ['default: __shared_default__'] : [])
  ];

  // Combine: shared code + primary code + shared exports (if any)
  const parts = [
    strippedSharedCode.trim(),
    '',
    primaryWithoutSharedImports.trim()
  ];

  // Only add the Shared export if there are actual exports needed by satellites
  if (sharedExportEntries.length > 0) {
    const sharedExportObject = `const ${sharedProperty} = { ${sharedExportEntries.join(', ')} };`;
    parts.push('', sharedExportObject, `export { ${sharedProperty} };`);
  }

  primaryChunk.code = parts.join('\n');
}
