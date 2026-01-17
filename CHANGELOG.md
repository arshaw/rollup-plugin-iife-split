# Changelog

## 0.0.2

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
