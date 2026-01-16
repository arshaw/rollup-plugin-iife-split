import { sharedHelper, processValue, SHARED_CONFIG } from './shared.js';

// Different name, no collision
function localHelper() {
  return 'main-local-helper';
}

export function mainFeature() {
  const local = localHelper();
  const shared = sharedHelper();
  const processed = processValue('test');
  const config = SHARED_CONFIG.version;
  return local + ' | ' + shared + ' | ' + processed + ' | ' + config;
}
