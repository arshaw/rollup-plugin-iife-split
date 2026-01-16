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
        width: 'Widget',      // Browser global: window.MyLib.Widget
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

| Option | Type | Description |
|--------|------|-------------|
| `primary` | `string` | Name of the primary entry (must match a key in Rollup's `input`) |
| `globalName` | `string` | Browser global variable name for the primary entry |
| `sharedProperty` | `string` | Property name on the global where shared exports are attached |

## How It Works

1. **Build phase**: Rollup builds with ESM format, using `manualChunks` to consolidate all shared modules into one chunk
2. **Transform phase**: In `generateBundle`, the plugin:
   - Merges the shared chunk into the primary entry
   - Converts each chunk from ESM to IIFE using a nested Rollup instance
   - Deletes the shared chunk from output

## License

MIT
