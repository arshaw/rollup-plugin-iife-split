import { sharedUtil, SHARED_CONSTANT } from './shared.js';

export function secondaryFeature() {
  return 'Secondary: ' + sharedUtil() + ' (' + SHARED_CONSTANT + ')';
}
