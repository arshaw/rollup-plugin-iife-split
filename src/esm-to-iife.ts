import { rollup, type Plugin } from 'rollup';
import { SHARED_CHUNK_NAME } from './chunk-analyzer.js';

export interface ConvertOptions {
  code: string;
  globalName: string | undefined;
  globals: Record<string, string>;
  sharedGlobalPath: string | null;
  sharedChunkFileName: string | null;
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

export async function convertToIife(options: ConvertOptions): Promise<string> {
  const { code, globalName, globals, sharedGlobalPath, sharedChunkFileName } = options;

  // Build the globals map for Rollup
  const rollupGlobals: Record<string, string> = { ...globals };

  // Add shared chunk mappings
  if (sharedGlobalPath && sharedChunkFileName) {
    // Map various forms of the shared chunk import to the shared global
    rollupGlobals[`./${sharedChunkFileName}`] = sharedGlobalPath;
    rollupGlobals[sharedChunkFileName] = sharedGlobalPath;
    rollupGlobals[`./${sharedChunkFileName.replace(/\.js$/, '')}`] = sharedGlobalPath;

    // Also handle __shared__ naming
    rollupGlobals[`./${SHARED_CHUNK_NAME}.js`] = sharedGlobalPath;
    rollupGlobals[SHARED_CHUNK_NAME] = sharedGlobalPath;
  }

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

  return output[0].code;
}
