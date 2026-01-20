# rollup-plugin-iife-split

A Rollup plugin that enables intelligent code-splitting for IIFE output.

## The Problem

Rollup's native IIFE output doesn't support code-splitting. With ESM, Rollup automatically creates shared chunks that are imported transparently. But with IIFE, you'd need to manually add `<script>` tags for each chunk, and those chunk names change between builds.

## The Solution

This plugin:
1. Uses Rollup's ESM code-splitting internally
2. Merges all shared code into a "primary" entry point
3. Converts everything to IIFE at the last moment
4. Satellite entries access shared code via a global variable

The result: You get code-splitting benefits with only one `<script>` tag per entry point.

## Installation

```bash
npm install rollup-plugin-iife-split
```

## Usage

```js
// rollup.config.js
import iifeSplit from 'rollup-plugin-iife-split';

export default {
  input: {
    main: 'src/main.js',
    admin: 'src/admin.js',
    widget: 'src/widget.js'
  },
  plugins: [
    iifeSplit({
      primary: 'main',        // Which entry gets the shared code
      primaryGlobal: 'MyLib', // Browser global: window.MyLib
      secondaryProps: {
        admin: 'Admin',       // Browser global: window.MyLib.Admin
        widget: 'Widget',     // Browser global: window.MyLib.Widget
      },
      sharedProp: 'Shared',   // Shared code at: window.MyLib.Shared
    })
  ],
  output: {
    dir: 'dist'
  }
};
```

## Output

**main.js** (primary entry):
```js
var MyLib = (function (exports) {
  // Shared code from all common dependencies
  function sharedUtil() { /* ... */ }

  // Main entry code
  function mainFeature() { /* ... */ }

  exports.mainFeature = mainFeature;
  exports.Shared = { sharedUtil };
  return exports;
})({});
```

**admin.js** (satellite entry):
```js
MyLib.Admin = (function (exports, shared) {
  // Uses shared code via parameter
  function adminFeature() {
    return shared.sharedUtil();
  }

  exports.adminFeature = adminFeature;
  return exports;
})({}, MyLib.Shared);
```

## HTML Usage

```html
<!-- Load primary first (contains shared code) -->
<script src="dist/main.js"></script>

<!-- Then load any satellite entries you need -->
<script src="dist/admin.js"></script>

<script>
  MyLib.mainFeature();
  MyLib.Admin.adminFeature();
</script>
```

## Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `primary` | `string` | Yes | Name of the primary entry (must match a key in Rollup's `input`). Shared code is merged into this entry. |
| `primaryGlobal` | `string` | Yes | Browser global variable name for the primary entry. Example: `'MyLib'` → `window.MyLib` |
| `secondaryProps` | `Record<string, string>` | Yes | Maps secondary entry names to their property name on the primary global. Example: `{ admin: 'Admin' }` → `window.MyLib.Admin` |
| `sharedProp` | `string` | Yes | Property name on the global where shared exports are attached. Example: `'Shared'` → `window.MyLib.Shared` |
| `unshared` | `(id: string) => boolean` | No | Function that returns `true` for modules that should be duplicated instead of shared. See [Excluding Modules from Sharing](#excluding-modules-from-sharing). |
| `debugDir` | `string` | No | Directory to write intermediate files for debugging. If set, writes ESM files before IIFE conversion to help diagnose issues. Example: `'./debug-output'` |
| `skipRequireGlobals` | `boolean` | No | If `true`, don't error when an external module is missing a `globals` mapping. Instead, let Rollup auto-generate a sanitized global name. Default: `false` |

## Excluding Modules from Sharing

By default, any module imported by multiple entries is consolidated into the shared chunk (merged into primary). However, some modules should be duplicated in each entry instead—for example, locale files that should be self-contained.

Use the `unshared` option to exclude specific modules from sharing:

```js
iifeSplit({
  primary: 'main',
  primaryGlobal: 'MyLib',
  secondaryProps: {
    'locale-en': 'LocaleEn',
    'locale-fr': 'LocaleFr',
    'locales-all': 'LocalesAll'
  },
  sharedProp: 'Shared',
  unshared(id) {
    // Locale files should be duplicated, not shared
    return /\/locales\/[\w-]+\.js$/.test(id)
  }
})
```

With this configuration:
- Locale modules matching the pattern are **duplicated** in each entry that imports them
- They are **not** merged into the primary/shared chunk
- Each satellite entry is self-contained with its own copy of the locale data

## External Dependencies

When using external dependencies with IIFE output, you must specify `globals` in your Rollup output options to map module IDs to global variable names:

```js
export default {
  input: { /* ... */ },
  external: ['lodash', '@fullcalendar/core'],
  plugins: [iifeSplit({ /* ... */ })],
  output: {
    dir: 'dist',
    globals: {
      'lodash': '_',
      '@fullcalendar/core': 'FullCalendar'
    }
  }
};
```

By default, the plugin will error if an external is missing from `globals`—this prevents invalid JavaScript output. If you want Rollup to auto-generate global names instead, set `skipRequireGlobals: true`.

## How It Works

1. **Build phase**: Rollup builds with ESM format, using `manualChunks` to consolidate all shared modules into one chunk
2. **Transform phase**: In `generateBundle`, the plugin:
   - Merges the shared chunk into the primary entry
   - Converts each chunk from ESM to IIFE using a nested Rollup instance
   - Deletes the shared chunk from output

## License

MIT
