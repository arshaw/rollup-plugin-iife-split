# Changelog

## 0.0.5 (2026-01-20)

### Fixed

- **Banner/footer placement**: `output.banner` and `output.footer` options now appear outside the IIFE wrapper instead of inside it.
- **Merge collision with external imports**: Shared declarations no longer collide with names imported from external packages in the primary chunk (e.g., `import { globalPlugins } from 'external'` no longer conflicts with a shared `globalPlugins` variable).

## 0.0.4 (2026-01-19)

### Fixed

- **Duplicate external imports**: When both the primary and shared chunk import from the same external package, the merged output no longer contains duplicate import statements.
- **External import ordering**: External imports are now correctly placed before their usage in the merged output. Previously, imports could appear after the code that used them.
- **Empty Shared object**: The `Shared` export is no longer created when there are no shared exports needed by satellites.

### Added

- **`skipRequireGlobals` option**: When `false` (default), the plugin errors if an external module is missing a `globals` mapping—IIFE builds require this for correct output. Set to `true` to let Rollup auto-generate sanitized global names instead.

### Changed

- External modules without a `globals` mapping now throw a clear error by default, explaining how to fix it. Previously, Rollup would silently generate potentially invalid JavaScript identifiers.

## 0.0.3 (2026-01-19)

### Fixed

- Aliased imports from the shared chunk are now correctly rewritten. Previously, imports like `import { cU as Calendar$1 }` would leave dangling references to `Calendar$1` after merging.
- Re-exports combined with aliased imports no longer cause build failures.

### Changed

- Replaced `debug: boolean` with `debugDir: string`. Instead of truncated console output, intermediate files are now written to the specified directory for easier debugging.

## 0.0.2 (2026-01-17)

### Added

- **`unshared` option**: Exclude specific modules from the shared chunk. Modules matching `unshared(id) => true` are duplicated in each entry that imports them instead of being consolidated into the primary bundle. Useful for locale files or other modules that should be self-contained in each entry.

  ```js
  iifeSplit({
    // ...
    unshared(id) {
      return /\/locales\/[\w-]+\.js$/.test(id)
    }
  })
  ```

### Changed

- Debug comments (e.g., `// === Shared code ===`) are now only included when `debug: true` is set.

## 0.0.1

Initial release.
