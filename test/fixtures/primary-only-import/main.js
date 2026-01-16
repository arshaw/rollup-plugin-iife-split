import { sharedUtil, primaryOnlyUtil } from './shared.js';

export function mainFeature() {
  return 'Main: ' + sharedUtil() + ' + ' + primaryOnlyUtil();
}
