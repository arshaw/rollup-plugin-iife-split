export function sharedUtil() {
  return 'shared-value';
}

// Use globalThis to prevent tree-shaking
export function registerGlobal(name, value) {
  globalThis[name] = value;
}

export const SHARED_VERSION = '1.0.0';
