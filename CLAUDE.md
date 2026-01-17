# Architecture

## File Structure

```
src/
├── index.ts          # Main plugin entry, Rollup hooks
├── types.ts          # TypeScript interfaces
├── chunk-analyzer.ts # Identifies shared/primary/satellite chunks
├── chunk-merger.ts   # Merges shared chunk into primary (AST manipulation)
└── esm-to-iife.ts    # ESM→IIFE conversion via nested Rollup instance
```

## Data Flow

```
Rollup Build (ESM)
       │
       ▼
┌─────────────────┐
│  manualChunks   │  Consolidates shared modules into __shared__ chunk
│                 │  (unless excluded by `unshared` option)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ generateBundle  │  Hook runs before files are written
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ analyzeChunks   │  Identifies: sharedChunk, primaryChunk, satelliteChunks,
│                 │  and unsharedChunks (modules excluded from sharing)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ mergeShared     │  Injects shared code into primary, creates Shared export
│ IntoPrimary     │  Uses Rollup's parser + magic-string for AST manipulation
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ mergeUnshared   │  Inlines unshared chunks into each importing entry
│ IntoImporters   │  (duplicates code instead of sharing)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ convertToIife   │  Nested Rollup instance converts ESM→IIFE
│ (parallel)      │  Runs for primary + all satellites concurrently
└────────┬────────┘
         │
         ▼
    Output Files
```

## Key Implementation Details

### Manual Chunking (`index.ts`)

```ts
manualChunks: (id, { getModuleInfo }) => {
  const info = getModuleInfo(id);
  if (info?.importers.length > 1) {
    if (unshared?.(id)) return undefined; // Let Rollup create separate chunk
    return '__shared__';
  }
  return undefined;
}
```

A module is "shared" if it has more than one importer. All shared modules go into a single `__shared__` chunk, unless the `unshared` option excludes them.

### Chunk Merger (`chunk-merger.ts`)

**Shared chunk merging** (`mergeSharedIntoPrimary`):
1. Strips `export` keywords from shared code
2. Removes shared imports from primary
3. Prepends shared code to primary
4. Creates `const Shared = { exportedName: localName, ... }` object

**Unshared chunk merging** (`mergeUnsharedIntoImporters`):
1. For each unshared chunk, identifies all entries that import from it
2. Renames all declarations with unique prefix (e.g., `messages` → `__locale_en$messages`)
3. Inlines the renamed code into each importing entry
4. Rewrites import references to use the new local names

The unique prefix prevents conflicts when multiple unshared chunks export the same names.

Handles Rollup's export aliasing (e.g., `export { foo as f }`).

### ESM→IIFE Conversion (`esm-to-iife.ts`)

Creates a nested Rollup instance with:
- Virtual plugin providing ESM code as input
- All imports marked as external
- Output format: `iife` with appropriate `globals` mapping

This produces proper IIFEs where external dependencies are passed as parameters:
```js
(function (exports, shared) { ... })({}, MyLib.Shared)
```

## Testing

Tests use vitest and build actual fixtures through the plugin:
- `test/fixtures/basic/` - Two entries, one shared module
- `test/fixtures/multi-shared/` - Three entries, two shared modules
- `test/fixtures/unshared/` - Multiple locale entries testing the `unshared` option

Tests execute output in Node's `vm` module to verify runtime correctness.

See comment at top of `test/plugin.test.ts` for debugging instructions.

## Code Style

- **Imports**: Use extensionless relative imports (e.g., `from './types'` not `from './types.js'`). The tsconfig uses `moduleResolution: bundler` which supports this.

## Dependencies

- `estree-walker` - AST traversal
- `magic-string` - String manipulation with source map support
- `rollup` - Peer dependency, also used internally for ESM→IIFE conversion. The plugin uses Rollup's `this.parse()` for parsing, making it parser-agnostic and Rolldown-compatible.
