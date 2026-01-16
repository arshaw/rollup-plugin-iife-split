// Used by both primary and secondary
export function sharedUtil() {
  return 'shared';
}

// Only used by primary - should NOT be in Shared export
export function primaryOnlyUtil() {
  return 'primary-only';
}

// Only used by secondary
export function secondaryOnlyUtil() {
  return 'secondary-only';
}
