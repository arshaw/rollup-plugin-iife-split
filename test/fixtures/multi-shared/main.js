import { formatDate } from './utils.js';
import { capitalize } from './helpers.js';

export function mainFeature() {
  return capitalize('main: ' + formatDate(new Date()));
}

export const MAIN_ID = 'main-entry';
