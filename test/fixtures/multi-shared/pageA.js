import { formatDate } from './utils.js';
import { capitalize } from './helpers.js';

export function pageAFeature() {
  return capitalize('page-a: ' + formatDate(new Date()));
}
