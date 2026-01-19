// Import Calendar from shared - Rollup will rename this to avoid collision
// with the local Calendar class defined below
import { Calendar as BaseCalendar, SHARED_VALUE } from './shared.js';

// Local Calendar class that extends the imported one
// This creates a name collision scenario
class Calendar extends BaseCalendar {
  constructor(name, extra) {
    super(name);
    this.extra = extra;
  }

  getFullName() {
    return `${this.getName()} (${this.extra})`;
  }
}

// Also use BaseCalendar directly to ensure it's not tree-shaken
export function createBaseCalendar(name) {
  return new BaseCalendar(name);
}

export function createCalendar(name, extra) {
  return new Calendar(name, extra);
}

export { SHARED_VALUE };
