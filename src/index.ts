import type { Plugin, OutputOptions, GetManualChunk } from 'rollup';
import type { IifeSplitOptions } from './types.js';
import { analyzeChunks, SHARED_CHUNK_NAME } from './chunk-analyzer.js';
import { convertToIife } from './esm-to-iife.js';
import { mergeSharedIntoPrimary } from './chunk-merger.js';

export type { IifeSplitOptions };

export default function iifeSplit(options: IifeSplitOptions): Plugin {
  const { primary, globalName, sharedProperty } = options;

  // Store globals from output options for use in generateBundle
  let outputGlobals: Record<string, string> = {};

  // Create manual chunks function to consolidate shared modules
  const manualChunks: GetManualChunk = (id, { getModuleInfo }) => {
    const moduleInfo = getModuleInfo(id);
    if (!moduleInfo) return undefined;

    // Skip entry points - they should remain as separate chunks
    if (moduleInfo.isEntry) return undefined;

    // A module is "shared" if it has more than one importer
    const importers = moduleInfo.importers || [];
    if (importers.length > 1) {
      return SHARED_CHUNK_NAME;
    }

    return undefined;
  };

  return {
    name: 'iife-split',

    // Hook into outputOptions to capture globals and configure chunking
    outputOptions(outputOptions: OutputOptions): OutputOptions {
      // Store globals for later use
      outputGlobals = (outputOptions.globals as Record<string, string>) ?? {};

      // Force ESM format for Rollup's internal processing
      // and configure manual chunking
      return {
        ...outputOptions,
        format: 'es',
        manualChunks
      };
    },

    // Main transformation hook - convert ESM chunks to IIFE
    async generateBundle(outputOptions, bundle) {
      // Step 1: Analyze the bundle to identify chunk types
      const analysis = analyzeChunks(bundle, primary);

      // Step 2: If there's a shared chunk, merge it into primary
      const sharedChunkFileName = analysis.sharedChunk?.fileName ?? null;

      if (analysis.sharedChunk) {
        mergeSharedIntoPrimary(
          analysis.primaryChunk,
          analysis.sharedChunk,
          sharedProperty
        );

        // Remove the shared chunk from output (it's now merged into primary)
        delete bundle[analysis.sharedChunk.fileName];
      }

      // Step 3: Convert all chunks to IIFE in parallel
      const conversions: Promise<void>[] = [];

      // Convert primary chunk
      conversions.push(
        convertToIife({
          code: analysis.primaryChunk.code,
          globalName,
          globals: outputGlobals,
          sharedGlobalPath: null, // Primary doesn't need to import shared
          sharedChunkFileName: null
        }).then(code => {
          analysis.primaryChunk.code = code;
        })
      );

      // Convert satellite chunks
      for (const satellite of analysis.satelliteChunks) {
        // Derive global name from entry name (capitalize first letter)
        const satelliteGlobalName = satellite.name.charAt(0).toUpperCase() +
          satellite.name.slice(1);

        conversions.push(
          convertToIife({
            code: satellite.code,
            globalName: satelliteGlobalName,
            globals: outputGlobals,
            sharedGlobalPath: `${globalName}.${sharedProperty}`,
            sharedChunkFileName
          }).then(code => {
            satellite.code = code;
          })
        );
      }

      await Promise.all(conversions);
    }
  };
}
