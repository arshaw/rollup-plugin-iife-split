import { sharedUtil } from './shared.js';

export function mainFeature() {
  return 'Main: ' + sharedUtil();
}

export const MAIN_VERSION = '1.0.0';
