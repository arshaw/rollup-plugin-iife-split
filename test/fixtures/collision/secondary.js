import { sharedHelper, processValue, SHARED_CONFIG } from './shared.js';

export function secondaryFeature() {
  const helper = sharedHelper();
  const processed = processValue('secondary');
  const config = SHARED_CONFIG.version;
  return 'Secondary: ' + helper + ' | ' + processed + ' | ' + config;
}
