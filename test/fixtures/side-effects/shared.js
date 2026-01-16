export function sharedUtil() {
  return 'shared-value';
}

export let sideEffectRan = false;

export function markSideEffectRan() {
  sideEffectRan = true;
}
