import { rollup, type Plugin } from 'rollup';
import { walk } from 'estree-walker';
import type { Node, Identifier, MemberExpression, FunctionExpression } from 'estree';
import MagicString from 'magic-string';
import { SHARED_CHUNK_NAME } from './chunk-analyzer';
import type { ParseFn } from './types';

// For node positions from the parser
interface WithPosition {
  start: number;
  end: number;
}

export interface ConvertOptions {
  code: string;
  globalName: string | undefined;
  globals: Record<string, string>;
  sharedGlobalPath: string | null;
  sharedChunkFileName: string | null;
  parse: ParseFn;
  skipRequireGlobals?: boolean;
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
function extractSharedImportMappings(code: string, parse: ParseFn): ImportMapping[] {
  const ast = parse(code) as Node;

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
function destructureSharedParameter(code: string, mappings: ImportMapping[], parse: ParseFn): string {
  const ast = parse(code) as Node;

  const ms = new MagicString(code);

  // Find the IIFE's FunctionExpression
  let sharedParamStart = -1;
  let sharedParamEnd = -1;
  let sharedParamName: string | null = null;

  walk(ast, {
    enter(node) {
      // Find the first FunctionExpression (the IIFE)
      if (sharedParamName === null && node.type === 'FunctionExpression') {
        const fn = node as FunctionExpression;
        const params = fn.params;
        if (params.length > 0) {
          // Last parameter is always the shared one
          const lastParam = params[params.length - 1];
          if (lastParam.type === 'Identifier') {
            const acornParam = lastParam as Identifier & WithPosition;
            sharedParamStart = acornParam.start;
            sharedParamEnd = acornParam.end;
            sharedParamName = lastParam.name;
          }
        }
      }
    }
  });

  if (sharedParamName === null) {
    return code;
  }

  // Collect all MemberExpression accesses on the shared param
  const propertyAccesses: Array<{ start: number; end: number; propName: string }> = [];

  walk(ast, {
    enter(node) {
      if (node.type === 'MemberExpression') {
        const memberNode = node as MemberExpression & WithPosition;
        const obj = memberNode.object;
        if (obj.type === 'Identifier' && obj.name === sharedParamName && !memberNode.computed) {
          const prop = memberNode.property as Identifier;
          propertyAccesses.push({
            start: memberNode.start,
            end: memberNode.end,
            propName: prop.name
          });
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
  ms.overwrite(sharedParamStart, sharedParamEnd, destructurePattern);

  // Replace all property accesses: sharedParam.prop -> localName
  for (const { start, end, propName } of propertyAccesses) {
    const localName = importToLocal.get(propName) ?? propName;
    ms.overwrite(start, end, localName);
  }

  // Remove 'use strict' directive - it's illegal with destructuring parameters
  walk(ast, {
    enter(node) {
      if (node.type === 'ExpressionStatement') {
        const exprStmt = node as Node & WithPosition & { expression: Node & { value?: unknown } };
        if (exprStmt.expression.type === 'Literal' && exprStmt.expression.value === 'use strict') {
          ms.remove(exprStmt.start, exprStmt.end);
        }
      }
    }
  });

  return ms.toString();
}

export async function convertToIife(options: ConvertOptions): Promise<string> {
  const { code, globalName, globals, sharedGlobalPath, sharedChunkFileName, parse, skipRequireGlobals } = options;

  // For satellite chunks, extract import mappings BEFORE IIFE conversion
  // These will be used to create destructuring parameter with nice names
  const importMappings = sharedGlobalPath ? extractSharedImportMappings(code, parse) : [];

  // Build the globals function for Rollup
  // Use a function to flexibly match the shared chunk import regardless of exact path format
  const rollupGlobals = (id: string): string | undefined => {
    // Rollup calls globals() for the IIFE's own name - return it as-is
    if (globalName && (id === globalName || globalName.startsWith(id + '.'))) {
      return id;
    }

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

    // Fall back to user-provided globals
    const global = globals[id];
    if (global === undefined) {
      if (skipRequireGlobals) {
        // Let Rollup generate a sanitized global name
        return undefined;
      }
      // Error if an external doesn't have a global mapping - IIFE builds require this
      throw new Error(
        `[iife-split] Missing global for external "${id}". ` +
        `IIFE builds require all externals to have a global mapping. ` +
        `Add it to output.globals in your Rollup config, e.g.: globals: { '${id}': 'SomeGlobalName' }`
      );
    }
    return global;
  };

  const bundle = await rollup({
    input: VIRTUAL_ENTRY,
    plugins: [createVirtualPlugin(code)],
    onwarn: () => {} // Suppress warnings
  });

  const { output } = await bundle.generate({
    format: 'iife',
    name: globalName,
    // Cast needed: Rollup's types say string, but it handles undefined by using default name generation
    globals: rollupGlobals as (id: string) => string,
    exports: 'named'
  });

  await bundle.close();

  let result = output[0].code;

  // For satellite chunks that import from the shared chunk, transform to use
  // destructuring with original names. Only do this if there are actual imports
  // from the shared chunk (importMappings.length > 0).
  if (sharedGlobalPath && importMappings.length > 0) {
    result = stripNamespaceGuards(result);
    result = destructureSharedParameter(result, importMappings, parse);
  } else if (globalName && !globalName.includes('.')) {
    // Primary chunk - no additional processing needed
  } else if (globalName) {
    // Satellite chunk with no shared imports - just strip namespace guards
    result = stripNamespaceGuards(result);
  }

  return result;
}
