# Changelog

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
