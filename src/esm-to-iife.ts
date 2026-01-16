import { rollup, type Plugin } from 'rollup';
import * as acorn from 'acorn';
import { walk } from 'estree-walker';
import type { Node, Identifier, MemberExpression, FunctionExpression, Pattern } from 'estree';
import MagicString from 'magic-string';
import { SHARED_CHUNK_NAME } from './chunk-analyzer.js';

export interface ConvertOptions {
  code: string;
  globalName: string | undefined;
  globals: Record<string, string>;
  sharedGlobalPath: string | null;
  sharedChunkFileName: string | null;
  debug?: boolean;
}

const VIRTUAL_ENTRY = '\0virtual:entry';

function createVirtualPlugin(code: string): Plugin {
  return {
    name: 'virtual-entry',
    resolveId(id) {
      if (id === VIRTUAL_ENTRY) {
        return id;
      }
      // Mark all other imports as external
      return { id, external: true };
    },
    load(id) {
      if (id === VIRTUAL_ENTRY) {
        return code;
      }
      return null;
    }
  };
}

/**
 * Mapping from imported name (e.g., 's') to local name (e.g., 'sharedUtil')
 */
interface ImportMapping {
  imported: string;  // The name exported from shared chunk (often minified like 's')
  local: string;     // The local name used in the satellite (like 'sharedUtil')
}

/**
 * Extracts import mappings from satellite ESM code.
 *
 * Parses imports like:
 *   import { s as sharedUtil, S as SHARED_CONSTANT } from './__shared__-xxx.js';
 *
 * Returns mappings: [{ imported: 's', local: 'sharedUtil' }, { imported: 'S', local: 'SHARED_CONSTANT' }]
 */
function extractSharedImportMappings(code: string): ImportMapping[] {
  const ast = acorn.parse(code, {
    ecmaVersion: 'latest',
    sourceType: 'module'
  }) as Node;

  const mappings: ImportMapping[] = [];

  walk(ast, {
    enter(node) {
      if (node.type === 'ImportDeclaration') {
        const importNode = node as Node & {
          source: { value: unknown };
          specifiers: Array<{
            type: string;
            imported?: Identifier;
            local: Identifier;
          }>;
        };
        const source = importNode.source.value;

        // Check if this import is from the shared chunk
        if (typeof source === 'string' && source.includes(SHARED_CHUNK_NAME)) {
          for (const spec of importNode.specifiers) {
            if (spec.type === 'ImportSpecifier' && spec.imported) {
              mappings.push({
                imported: spec.imported.name,
                local: spec.local.name
              });
            } else if (spec.type === 'ImportDefaultSpecifier') {
              mappings.push({
                imported: 'default',
                local: spec.local.name
              });
            }
          }
        }
      }
    }
  });

  return mappings;
}

interface NodeWithRange extends Node {
  start: number;
  end: number;
}

/**
 * Strips Rollup's namespace guard pattern from satellite IIFEs.
 *
 * Before:
 *   this.FullCalendar = this.FullCalendar || {};
 *   this.FullCalendar.ClassicTheme = (function (exports, ...) { ... })(...);
 *
 * After:
 *   FullCalendar.ClassicTheme = (function (exports, ...) { ... })(...);
 */
function stripNamespaceGuards(code: string): string {
  // Remove lines like: this.X = this.X || {};
  let result = code.replace(/^this\.\w+\s*=\s*this\.\w+\s*\|\|\s*\{\};\n/gm, '');

  // Replace this.X.Y = with X.Y =
  result = result.replace(/^this\.(\w+\.\w+)\s*=/gm, '$1 =');

  return result;
}

/**
 * Transforms satellite IIFE to use destructuring parameter with original names.
 *
 * Before:
 *   (function (exports, __shared__xxx_js) {
 *     __shared__xxx_js.s();
 *     __shared__xxx_js.S;
 *   })({}, MyLib.Shared);
 *
 * After:
 *   (function (exports, { s: sharedUtil, S: SHARED_CONSTANT }) {
 *     sharedUtil();
 *     SHARED_CONSTANT;
 *   })({}, MyLib.Shared);
 */
function destructureSharedParameter(code: string, mappings: ImportMapping[]): string {
  const ast = acorn.parse(code, {
    ecmaVersion: 'latest',
    sourceType: 'script'
  }) as NodeWithRange;

  const ms = new MagicString(code);

  // Find the IIFE's FunctionExpression
  let iifeFn: (FunctionExpression & NodeWithRange) | null = null;
  let sharedParam: (Pattern & NodeWithRange) | null = null;
  let sharedParamName: string | null = null;

  walk(ast, {
    enter(node) {
      // Find the first FunctionExpression (the IIFE)
      if (!iifeFn && node.type === 'FunctionExpression') {
        iifeFn = node as FunctionExpression & NodeWithRange;
        const params = iifeFn.params;
        if (params.length > 0) {
          // Last parameter is always the shared one
          const lastParam = params[params.length - 1] as Pattern & NodeWithRange;
          if (lastParam.type === 'Identifier') {
            sharedParam = lastParam;
            sharedParamName = (lastParam as Identifier).name;
          }
        }
      }
    }
  });

  if (!sharedParam || !sharedParamName) {
    return code;
  }

  // Collect all MemberExpression accesses on the shared param
  // and build mappings if not provided
  const propertyAccesses: Array<{ node: MemberExpression & NodeWithRange; propName: string }> = [];

  walk(ast, {
    enter(node) {
      if (node.type === 'MemberExpression') {
        const memberNode = node as MemberExpression & NodeWithRange;
        const obj = memberNode.object;
        if (obj.type === 'Identifier' && obj.name === sharedParamName && !memberNode.computed) {
          const prop = memberNode.property as Identifier;
          propertyAccesses.push({ node: memberNode, propName: prop.name });
        }
      }
    }
  });

  // If no mappings provided, create them from property accesses
  let effectiveMappings = mappings;
  if (effectiveMappings.length === 0) {
    const propNames = new Set(propertyAccesses.map(a => a.propName));
    effectiveMappings = Array.from(propNames).map(prop => ({
      imported: prop,
      local: prop
    }));
  }

  if (effectiveMappings.length === 0) {
    return code;
  }

  // Build a lookup from imported name to local name
  const importToLocal = new Map(effectiveMappings.map(m => [m.imported, m.local]));

  // Replace the parameter with destructuring pattern
  const destructureEntries = effectiveMappings.map(m =>
    m.imported === m.local ? m.imported : `${m.imported}: ${m.local}`
  );
  const destructurePattern = `{ ${destructureEntries.join(', ')} }`;
  ms.overwrite(sharedParam.start, sharedParam.end, destructurePattern);

  // Replace all property accesses: sharedParam.prop -> localName
  for (const { node, propName } of propertyAccesses) {
    const localName = importToLocal.get(propName) ?? propName;
    ms.overwrite(node.start, node.end, localName);
  }

  // Remove 'use strict' directive - it's illegal with destructuring parameters
  walk(ast, {
    enter(node) {
      if (node.type === 'ExpressionStatement') {
        const exprNode = node as NodeWithRange & { expression: NodeWithRange & { value?: string } };
        const expr = exprNode.expression;
        if (expr.type === 'Literal' && expr.value === 'use strict') {
          ms.remove(exprNode.start, exprNode.end);
        }
      }
    }
  });

  return ms.toString();
}

export async function convertToIife(options: ConvertOptions): Promise<string> {
  const { code, globalName, globals, sharedGlobalPath, sharedChunkFileName, debug } = options;

  // For satellite chunks, extract import mappings BEFORE IIFE conversion
  // These will be used to create destructuring parameter with nice names
  const importMappings = sharedGlobalPath ? extractSharedImportMappings(code) : [];

  if (debug && sharedGlobalPath) {
    console.log('\n=== DEBUG convertToIife ===');
    console.log('globalName:', globalName);
    console.log('sharedGlobalPath:', sharedGlobalPath);
    console.log('sharedChunkFileName:', sharedChunkFileName);
    console.log('--- ESM code (first 500 chars) ---');
    console.log(code.slice(0, 500));
    console.log('--- Import mappings ---');
    console.log(importMappings);
  }

  // Build the globals function for Rollup
  // Use a function to flexibly match the shared chunk import regardless of exact path format
  const rollupGlobals = (id: string): string => {
    // Check if this is a shared chunk import
    if (sharedGlobalPath) {
      // Match any import that contains __shared__ (the shared chunk pattern)
      if (id.includes(SHARED_CHUNK_NAME)) {
        return sharedGlobalPath;
      }
      // Also match by filename if provided
      if (sharedChunkFileName) {
        const fileNameWithoutExt = sharedChunkFileName.replace(/\.js$/, '');
        if (id.includes(fileNameWithoutExt)) {
          return sharedGlobalPath;
        }
      }
    }

    // Fall back to user-provided globals, or use id as-is
    return globals[id] ?? id;
  };

  const bundle = await rollup({
    input: VIRTUAL_ENTRY,
    plugins: [createVirtualPlugin(code)],
    onwarn: () => {} // Suppress warnings
  });

  const { output } = await bundle.generate({
    format: 'iife',
    name: globalName,
    globals: rollupGlobals,
    exports: 'named'
  });

  await bundle.close();

  let result = output[0].code;

  if (debug && sharedGlobalPath) {
    console.log('--- IIFE before destructuring (first 800 chars) ---');
    console.log(result.slice(0, 800));
  }

  // For satellite chunks, transform to use destructuring with original names
  // The function will extract property accesses as fallback if no mappings found
  if (sharedGlobalPath) {
    result = stripNamespaceGuards(result);
    result = destructureSharedParameter(result, importMappings);

    if (debug) {
      console.log('--- IIFE after destructuring (first 800 chars) ---');
      console.log(result.slice(0, 800));
      console.log('=== END DEBUG ===\n');
    }
  }

  return result;
}
