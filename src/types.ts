import type { OutputChunk } from 'rollup';
import type { Program } from 'estree';

/**
 * Parser function type - compatible with Rollup's this.parse()
 */
export type ParseFn = (code: string) => Program;

export interface IifeSplitOptions {
  /**
   * The name of the primary entry point (must match a key in Rollup's input map).
   * The shared chunk will be merged into this entry.
   */
  primary: string;

  /**
   * The global variable name for the primary entry's exports.
   * Example: 'MyLib' results in `window.MyLib = ...`
   */
  primaryGlobal: string;

  /**
   * Maps secondary entry names to their property name on the primary global.
   * Example: { admin: 'Admin', widget: 'Widget' } results in:
   *   - `window.MyLib.Admin` for the 'admin' entry
   *   - `window.MyLib.Widget` for the 'widget' entry
   */
  secondaryProps: Record<string, string>;

  /**
   * The property name on the global where shared exports are attached.
   * Example: 'Shared' results in `window.MyLib.Shared = { ... }`
   */
  sharedProp: string;

  /**
   * A function that returns true if a module should NOT be included in the shared chunk.
   * Unshared modules will be duplicated in each entry that imports them.
   *
   * This is useful for locale files or other modules that should be self-contained
   * in each entry rather than consolidated into the primary bundle.
   *
   * Example:
   * ```ts
   * unshared(id) {
   *   return /\/locales\/[\w-]+\.js$/.test(id)
   * }
   * ```
   */
  unshared?: (id: string) => boolean;

  /**
   * Enable debug logging to see intermediate transformation steps.
   */
  debug?: boolean;
}

export interface ChunkAnalysis {
  sharedChunk: OutputChunk | null;
  primaryChunk: OutputChunk;
  satelliteChunks: OutputChunk[];
  /** Non-entry, non-shared chunks that need to be inlined into their importers */
  unsharedChunks: OutputChunk[];
}
