import type { OutputBundle, OutputChunk, OutputAsset } from 'rollup';
import type { ChunkAnalysis } from './types';

function isOutputChunk(item: OutputChunk | OutputAsset): item is OutputChunk {
  return item.type === 'chunk';
}

export const SHARED_CHUNK_NAME = '__shared__';

export function analyzeChunks(
  bundle: OutputBundle,
  primaryEntryName: string
): ChunkAnalysis {
  const chunks = Object.values(bundle).filter(isOutputChunk);

  // Find the shared chunk (non-entry chunk, created by manualChunks)
  const sharedChunk = chunks.find(chunk =>
    !chunk.isEntry && chunk.name === SHARED_CHUNK_NAME
  ) || null;

  // Find the primary chunk by matching the entry name
  const primaryChunk = chunks.find(chunk =>
    chunk.isEntry && chunk.name === primaryEntryName
  );

  if (!primaryChunk) {
    const availableEntries = chunks
      .filter(c => c.isEntry)
      .map(c => c.name)
      .join(', ');
    throw new Error(
      `Primary entry "${primaryEntryName}" not found in bundle. ` +
      `Available entries: ${availableEntries}`
    );
  }

  // All other entry chunks are satellites
  const satelliteChunks = chunks.filter(chunk =>
    chunk.isEntry && chunk.name !== primaryEntryName
  );

  // Non-entry, non-shared chunks are "unshared" chunks that need to be inlined
  // These are created when a module is imported by multiple entries but was
  // excluded from the shared chunk via the unshared option
  const unsharedChunks = chunks.filter(chunk =>
    !chunk.isEntry && chunk.name !== SHARED_CHUNK_NAME
  );

  return { sharedChunk, primaryChunk, satelliteChunks, unsharedChunks };
}
