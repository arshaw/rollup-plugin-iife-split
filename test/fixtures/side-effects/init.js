// This entry has no exports - it's just for side effects
import { registerGlobal, SHARED_VERSION } from './shared.js';

// Run side effect on load - register the version globally
registerGlobal('INIT_LOADED', true);
registerGlobal('INIT_VERSION', SHARED_VERSION);
