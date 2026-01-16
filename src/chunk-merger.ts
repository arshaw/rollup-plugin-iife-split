import MagicString from 'magic-string';
import * as acorn from 'acorn';
import { walk } from 'estree-walker';
import type { OutputChunk } from 'rollup';
import type { Node, ExportNamedDeclaration, ExportDefaultDeclaration, Identifier, Program, VariableDeclaration, FunctionDeclaration, ClassDeclaration } from 'estree';
import { SHARED_CHUNK_NAME } from './chunk-analyzer';

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
function extractTopLevelDeclarations(code: string): Set<string> {
  const ast = acorn.parse(code, {
    ecmaVersion: 'latest',
    sourceType: 'module'
  }) as Program;

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
function renameIdentifiers(code: string, renameMap: Map<string, string>): string {
  if (renameMap.size === 0) return code;

  const ast = acorn.parse(code, {
    ecmaVersion: 'latest',
    sourceType: 'module'
  }) as Node;

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

function extractExports(code: string): ExportInfo {
  const ast = acorn.parse(code, {
    ecmaVersion: 'latest',
    sourceType: 'module'
  }) as Node;

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

function stripExports(code: string): string {
  const ast = acorn.parse(code, {
    ecmaVersion: 'latest',
    sourceType: 'module'
  }) as Node;

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
  sharedExportToLocal: Map<string, string>
): string {
  const ast = acorn.parse(code, {
    ecmaVersion: 'latest',
    sourceType: 'module'
  }) as Node;

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

export function mergeSharedIntoPrimary(
  primaryChunk: OutputChunk,
  sharedChunk: OutputChunk,
  sharedProperty: string
): void {
  // Extract export information BEFORE renaming to preserve original exported names
  const { exports: sharedExports, hasDefault } = extractExports(sharedChunk.code);

  // Extract declarations from both chunks to detect collisions
  const sharedDeclarations = extractTopLevelDeclarations(sharedChunk.code);
  const primaryDeclarations = extractTopLevelDeclarations(primaryChunk.code);

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
    processedSharedCode = renameIdentifiers(processedSharedCode, renameMap);
  }

  // Strip exports from shared code (convert to plain declarations)
  const strippedSharedCode = stripExports(processedSharedCode);

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
    sharedExportToLocal
  );

  // Build the shared exports object using exportedName: localName format
  // Apply rename map to localNames to reflect collision renames
  const sharedExportEntries = [
    ...sharedExports.map(exp => {
      const renamedLocal = renameMap.get(exp.localName) ?? exp.localName;
      return exp.exportedName === renamedLocal
        ? renamedLocal
        : `${exp.exportedName}: ${renamedLocal}`;
    }),
    ...(hasDefault ? ['default: __shared_default__'] : [])
  ];

  const sharedExportObject = `const ${sharedProperty} = { ${sharedExportEntries.join(', ')} };`;

  // Combine: shared code + primary code + shared exports
  primaryChunk.code = [
    '// === Shared code (merged by rollup-plugin-iife-split) ===',
    strippedSharedCode.trim(),
    '',
    '// === Primary entry code ===',
    primaryWithoutSharedImports.trim(),
    '',
    '// === Shared exports object ===',
    sharedExportObject,
    `export { ${sharedProperty} };`
  ].join('\n');
}
