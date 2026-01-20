// Secondary entry that uses shared
import { sharedHelper, SHARED_VALUE } from './shared.js';

export function secondaryFeature() {
  return 'Secondary: ' + sharedHelper() + ' (' + SHARED_VALUE + ')';
}
