import MagicString from 'magic-string';
import * as acorn from 'acorn';
import { walk } from 'estree-walker';
import type { OutputChunk } from 'rollup';
import type { Node, ExportNamedDeclaration, ExportDefaultDeclaration, Identifier } from 'estree';
import { SHARED_CHUNK_NAME } from './chunk-analyzer.js';

interface ExportMapping {
  exportedName: string;
  localName: string;
}

interface ExportInfo {
  exports: ExportMapping[];
  hasDefault: boolean;
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

function removeSharedImports(code: string, sharedChunkFileName: string): string {
  const ast = acorn.parse(code, {
    ecmaVersion: 'latest',
    sourceType: 'module'
  }) as Node;

  const s = new MagicString(code);

  walk(ast, {
    enter(node) {
      if (node.type === 'ImportDeclaration') {
        const importNode = node as Node & { start: number; end: number; source: { value: unknown } };
        const source = importNode.source.value;
        if (typeof source === 'string') {
          // Check if this import is from the shared chunk
          if (
            source.includes(SHARED_CHUNK_NAME) ||
            source.includes(sharedChunkFileName.replace(/\.js$/, ''))
          ) {
            s.remove(importNode.start, importNode.end);
          }
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
  // Extract export information from shared chunk
  const { exports: sharedExports, hasDefault } = extractExports(sharedChunk.code);

  // Strip exports from shared code (convert to plain declarations)
  const strippedSharedCode = stripExports(sharedChunk.code);

  // Remove shared chunk imports from primary
  const primaryWithoutSharedImports = removeSharedImports(
    primaryChunk.code,
    sharedChunk.fileName
  );

  // Build the shared exports object using exportedName: localName format
  const sharedExportEntries = [
    ...sharedExports.map(exp =>
      exp.exportedName === exp.localName
        ? exp.localName
        : `${exp.exportedName}: ${exp.localName}`
    ),
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
