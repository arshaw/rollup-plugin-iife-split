import type { Plugin, OutputOptions, GetManualChunk, AddonFunction } from 'rollup';
import type { IifeSplitOptions } from './types';
import { analyzeChunks, SHARED_CHUNK_NAME } from './chunk-analyzer';
import { convertToIife } from './esm-to-iife';
import { mergeSharedIntoPrimary, extractSharedImports, mergeUnsharedIntoImporters } from './chunk-merger';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export type { IifeSplitOptions };

export default function iifeSplit(options: IifeSplitOptions): Plugin {
  const { primary, primaryGlobal, secondaryProps, sharedProp, unshared, debugDir, skipRequireGlobals } = options;

  // Helper to write debug files
  const sanitizeName = (name: string) => name.replace(/[/\\]/g, '-');
  const writeDebugFile = (filename: string, content: string) => {
    if (!debugDir) return;
    try {
      mkdirSync(debugDir, { recursive: true });
      writeFileSync(join(debugDir, filename), content);
    } catch (e) {
      console.warn(`[iife-split] Failed to write debug file ${filename}:`, e);
    }
  };

  // Store globals from output options for use in generateBundle
  let outputGlobals: Record<string, string> = {};

  // Store banner/footer from output options - we intercept them so they appear
  // outside the IIFE wrapper rather than inside it
  let outputBanner: string | AddonFunction | undefined;
  let outputFooter: string | AddonFunction | undefined;

  // Create manual chunks function to consolidate shared modules
  const manualChunks: GetManualChunk = (id, { getModuleInfo }) => {
    const moduleInfo = getModuleInfo(id);
    if (!moduleInfo) return undefined;

    // Skip entry points - they should remain as separate chunks
    if (moduleInfo.isEntry) return undefined;

    // A module is "shared" if it has more than one importer
    const importers = moduleInfo.importers || [];
    if (importers.length > 1) {
      // Check if this module should be excluded from sharing
      // (unshared modules will be duplicated in each importing entry)
      if (unshared?.(id)) {
        return undefined; // Let Rollup create a separate chunk
      }
      return SHARED_CHUNK_NAME;
    }

    return undefined;
  };

  return {
    name: 'iife-split',

    // Hook into outputOptions to capture globals/banner/footer and configure chunking
    outputOptions(outputOptions: OutputOptions): OutputOptions {
      // Store globals for later use
      outputGlobals = (outputOptions.globals as Record<string, string>) ?? {};

      // Capture banner/footer - we'll apply them after IIFE conversion
      // so they appear outside the wrapper, not inside it
      outputBanner = outputOptions.banner;
      outputFooter = outputOptions.footer;

      // Force ESM format for Rollup's internal processing
      // and configure manual chunking
      return {
        ...outputOptions,
        format: 'es',
        manualChunks,
        // Remove banner/footer so Rollup doesn't embed them in ESM
        banner: undefined,
        footer: undefined
      };
    },

    // Main transformation hook - convert ESM chunks to IIFE
    async generateBundle(outputOptions, bundle) {
      // Get Rollup's parser - this makes us parser-agnostic (works with Rolldown too)
      const parse = this.parse.bind(this);

      // Step 1: Analyze the bundle to identify chunk types
      const analysis = analyzeChunks(bundle, primary);

      // Debug: Write original ESM chunks
      if (debugDir) {
        writeDebugFile('1-primary-original.js', analysis.primaryChunk.code);
        if (analysis.sharedChunk) {
          writeDebugFile('1-shared-original.js', analysis.sharedChunk.code);
        }
        for (const satellite of analysis.satelliteChunks) {
          writeDebugFile(`1-satellite-${sanitizeName(satellite.name)}-original.js`, satellite.code);
        }
        for (const unshared of analysis.unsharedChunks) {
          writeDebugFile(`1-unshared-${sanitizeName(unshared.name)}-original.js`, unshared.code);
        }
      }

      // Step 2: If there's a shared chunk, merge it into primary
      const sharedChunkFileName = analysis.sharedChunk?.fileName ?? null;

      if (analysis.sharedChunk) {
        // Collect which shared exports are actually needed by satellites
        const neededExports = new Set<string>();
        for (const satellite of analysis.satelliteChunks) {
          const imports = extractSharedImports(satellite.code, analysis.sharedChunk.fileName, parse);
          for (const imp of imports) {
            neededExports.add(imp);
          }
        }

        if (debugDir) {
          writeDebugFile('2-needed-exports.json', JSON.stringify(Array.from(neededExports), null, 2));
        }

        mergeSharedIntoPrimary(
          analysis.primaryChunk,
          analysis.sharedChunk,
          sharedProp,
          neededExports,
          parse
        );

        // Remove the shared chunk from output (it's now merged into primary)
        delete bundle[analysis.sharedChunk.fileName];
      }

      // Debug: Write merged ESM (after shared merge, before unshared merge)
      if (debugDir) {
        writeDebugFile('2-primary-after-shared-merge.js', analysis.primaryChunk.code);
      }

      // Step 2b: Merge unshared chunks into their importing entries
      // These are modules that were excluded from the shared chunk via the `unshared` option
      // They get duplicated in each entry that imports them
      const allEntries = [analysis.primaryChunk, ...analysis.satelliteChunks];
      for (const unsharedChunk of analysis.unsharedChunks) {
        mergeUnsharedIntoImporters(unsharedChunk, allEntries, parse);
        // Remove the unshared chunk from output (it's now inlined into importers)
        delete bundle[unsharedChunk.fileName];
      }

      // Debug: Write ESM after all merges, before IIFE conversion
      if (debugDir) {
        writeDebugFile('3-primary-before-iife.js', analysis.primaryChunk.code);
        for (const satellite of analysis.satelliteChunks) {
          writeDebugFile(`3-satellite-${sanitizeName(satellite.name)}-before-iife.js`, satellite.code);
        }
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
          parse,
          skipRequireGlobals
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
            parse,
            skipRequireGlobals
          }).then(code => {
            satellite.code = code;
          })
        );
      }

      await Promise.all(conversions);

      // Step 4: Apply banner/footer outside the IIFE wrapper
      if (outputBanner || outputFooter) {
        // Apply to all chunks in bundle
        for (const chunk of Object.values(bundle)) {
          if (chunk.type === 'chunk') {
            // Resolve banner/footer for this chunk (call if function, await if promise)
            const resolveBannerFooter = async (
              value: string | AddonFunction | undefined
            ): Promise<string> => {
              if (value === undefined) return '';
              if (typeof value === 'function') {
                return await value(chunk);
              }
              return value;
            };

            const banner = await resolveBannerFooter(outputBanner);
            const footer = await resolveBannerFooter(outputFooter);

            if (banner) {
              chunk.code = banner + '\n' + chunk.code;
            }
            if (footer) {
              chunk.code = chunk.code + '\n' + footer;
            }
          }
        }
      }
    }
  };
}
