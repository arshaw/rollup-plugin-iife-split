import { rollup, type Plugin } from 'rollup';
import * as acorn from 'acorn';
import { walk } from 'estree-walker';
import type { Node, Identifier } from 'estree';
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

/**
 * Extracts property accesses from IIFE code when named import mappings aren't available.
 *
 * Finds patterns like: __shared__xxx_js.propName
 * Returns mappings where imported === local (since we don't know the original name)
 */
function extractPropertyAccessMappings(code: string): ImportMapping[] {
  // Find the shared parameter name pattern
  const sharedParamPattern = /__shared__[A-Za-z0-9]+_+js/;
  const paramMatch = code.match(sharedParamPattern);
  if (!paramMatch) {
    return [];
  }

  const paramName = paramMatch[0];

  // Find all property accesses: __shared__xxx_js.propName
  const accessPattern = new RegExp(`${paramName}\\.(\\w+)`, 'g');
  const properties = new Set<string>();

  let match;
  while ((match = accessPattern.exec(code)) !== null) {
    properties.add(match[1]);
  }

  return Array.from(properties).map(prop => ({
    imported: prop,
    local: prop  // Use same name since we don't know the original
  }));
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
  // Find the shared parameter name pattern
  const sharedParamPattern = /__shared__[A-Za-z0-9]+_+js/g;
  const matches = code.match(sharedParamPattern);
  if (!matches || matches.length === 0) {
    return code;
  }

  const paramName = matches[0];

  // If no mappings provided, extract from property accesses in the code
  let effectiveMappings = mappings;
  if (effectiveMappings.length === 0) {
    effectiveMappings = extractPropertyAccessMappings(code);
  }

  if (effectiveMappings.length === 0) {
    return code;
  }

  // Build the destructuring pattern: { s: sharedUtil, S: SHARED_CONSTANT }
  const destructureEntries = effectiveMappings.map(m =>
    m.imported === m.local ? m.imported : `${m.imported}: ${m.local}`
  );
  const destructurePattern = `{ ${destructureEntries.join(', ')} }`;

  // Replace parameter declaration: __shared__xxx_js -> { s: sharedUtil, ... }
  // Handle both cases:
  // 1. Two params: (function (exports, __shared__xxx) - when satellite has exports
  // 2. One param: (function (__shared__xxx) - when satellite has no exports (side-effects only)
  let result = code;

  // Try two-parameter pattern first
  const twoParamPattern = new RegExp(`(function\\s*\\([^,]+,\\s*)${paramName}(\\s*\\))`);
  if (twoParamPattern.test(result)) {
    result = result.replace(twoParamPattern, `$1${destructurePattern}$2`);
  } else {
    // Try single-parameter pattern
    const oneParamPattern = new RegExp(`(function\\s*\\()${paramName}(\\s*\\))`);
    result = result.replace(oneParamPattern, `$1${destructurePattern}$2`);
  }

  // Remove 'use strict' directive - it's illegal with destructuring parameters
  // Match both single and double quoted versions
  result = result.replace(/\s*['"]use strict['"];\s*/g, '\n  ');

  // Replace all namespace accesses: __shared__xxx_js.prop -> localName
  for (const mapping of effectiveMappings) {
    // Match __shared__xxx_js.importedName and replace with localName
    const accessPattern = new RegExp(`${paramName}\\.${mapping.imported}\\b`, 'g');
    result = result.replace(accessPattern, mapping.local);
  }

  return result;
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
