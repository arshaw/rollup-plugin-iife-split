// Shared module with functions that will be used by multiple entries

export function sharedHelper() {
  return 'shared-helper-result';
}

export function processValue(value) {
  return 'shared-processed: ' + value;
}

export const SHARED_CONFIG = { version: '1.0' };
