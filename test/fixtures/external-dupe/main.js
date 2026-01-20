// Primary entry that also imports from the same external package
import { createPlugin } from 'externalLib';
import { sharedHelper, SHARED_VALUE } from './shared.js';

export function mainFeature() {
  const mainPlugin = createPlugin('main');
  return 'Main: ' + mainPlugin + ' + ' + sharedHelper() + ' (' + SHARED_VALUE + ')';
}
