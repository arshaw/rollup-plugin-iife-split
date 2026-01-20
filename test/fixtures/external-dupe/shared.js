// Shared module that imports from an external package
import { createPlugin } from 'externalLib';

export function sharedHelper() {
  return createPlugin('shared');
}

export const SHARED_VALUE = 'shared-value';
