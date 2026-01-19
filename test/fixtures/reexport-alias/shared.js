// Shared utilities - note we export both BaseWidget AND Widget
// This allows main.js to import one with an alias that collides with a re-export name

export class BaseWidget {
  constructor(name) {
    this.name = name;
  }
  getName() {
    return `Base: ${this.name}`;
  }
}

// "Widget" will be re-exported, but also used as an import alias in main.js
export class Widget {
  constructor(name) {
    this.name = name;
  }
  getName() {
    return `Widget: ${this.name}`;
  }
}

export const VERSION = '1.0.0';
