import type { Plugin, OutputOptions, GetManualChunk } from 'rollup';
import type { IifeSplitOptions } from './types';
import { analyzeChunks, SHARED_CHUNK_NAME } from './chunk-analyzer';
import { convertToIife } from './esm-to-iife';
import { mergeSharedIntoPrimary, extractSharedImports } from './chunk-merger';

export type { IifeSplitOptions };

export default function iifeSplit(options: IifeSplitOptions): Plugin {
  const { primary, primaryGlobal, secondaryProps, sharedProp, debug } = options;

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
        // Collect which shared exports are actually needed by satellites
        const neededExports = new Set<string>();
        for (const satellite of analysis.satelliteChunks) {
          const imports = extractSharedImports(satellite.code, analysis.sharedChunk.fileName);
          for (const imp of imports) {
            neededExports.add(imp);
          }
        }

        mergeSharedIntoPrimary(
          analysis.primaryChunk,
          analysis.sharedChunk,
          sharedProp,
          neededExports
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
          globalName: primaryGlobal,
          globals: outputGlobals,
          sharedGlobalPath: null, // Primary doesn't need to import shared
          sharedChunkFileName: null,
          debug
        }).then(code => {
          analysis.primaryChunk.code = code;
        })
      );

      // Convert satellite chunks
      for (const satellite of analysis.satelliteChunks) {
        // Look up the global property name for this satellite entry
        const satelliteProp = secondaryProps[satellite.name];

        // If satellite has exports, it must be in secondaryProps
        // If it has no exports (side-effects only), it can be omitted
        const hasExports = satellite.exports.length > 0;
        if (!satelliteProp && hasExports) {
          throw new Error(
            `Secondary entry "${satellite.name}" not found in secondaryProps. ` +
            `Available entries: ${Object.keys(secondaryProps).join(', ') || '(none)'}`
          );
        }

        // Satellite is assigned as a property on the primary global
        // e.g., MyLib.Admin for { admin: 'Admin' }
        // If no exports, we still convert to IIFE but without a global name
        const satelliteGlobalName = satelliteProp
          ? `${primaryGlobal}.${satelliteProp}`
          : undefined;

        conversions.push(
          convertToIife({
            code: satellite.code,
            globalName: satelliteGlobalName,
            globals: outputGlobals,
            sharedGlobalPath: `${primaryGlobal}.${sharedProp}`,
            sharedChunkFileName,
            debug
          }).then(code => {
            satellite.code = code;
          })
        );
      }

      await Promise.all(conversions);
    }
  };
}
