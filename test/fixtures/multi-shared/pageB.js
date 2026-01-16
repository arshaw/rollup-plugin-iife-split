import { formatDate } from './utils.js';
import { capitalize } from './helpers.js';

export function pageBFeature() {
  return capitalize('page-b: ' + formatDate(new Date()));
}
