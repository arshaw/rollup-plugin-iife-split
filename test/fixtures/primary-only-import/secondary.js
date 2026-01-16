import { sharedUtil, secondaryOnlyUtil } from './shared.js';

export function secondaryFeature() {
  return 'Secondary: ' + sharedUtil() + ' + ' + secondaryOnlyUtil();
}
