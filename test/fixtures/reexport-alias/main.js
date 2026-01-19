// KEY: Import BaseWidget AS "Widget" - this adds Widget → BaseWidget to namedImportRenames
import { BaseWidget as Widget, VERSION } from './shared.js';

// KEY: Re-export "Widget" from shared - the identifier "Widget" matches the import alias above!
// Without this.skip(), the walker would:
// 1. Overwrite the entire export statement
// 2. Visit the Identifier "Widget" inside it
// 3. Find "Widget" in namedImportRenames
// 4. Try to overwrite it -> CRASH: "Cannot split a chunk that has already been edited"
export { Widget as SharedWidget } from './shared.js';

// Use the imported Widget (which is actually BaseWidget)
export function createWidget(name) {
  return new Widget(name);
}

export { VERSION };
