import { sharedUtil, SHARED_CONSTANT } from './shared.js';

export function mainFeature() {
  return 'Main: ' + sharedUtil() + ' (' + SHARED_CONSTANT + ')';
}

export const MAIN_VERSION = '1.0.0';
