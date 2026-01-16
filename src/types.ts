import type { OutputChunk } from 'rollup';

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
  globalName: string;

  /**
   * The property name on the global where shared exports are attached.
   * Example: 'Shared' results in `window.MyLib.Shared = { ... }`
   */
  sharedProperty: string;
}

export interface ChunkAnalysis {
  sharedChunk: OutputChunk | null;
  primaryChunk: OutputChunk;
  satelliteChunks: OutputChunk[];
}
