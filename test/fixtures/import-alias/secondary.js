import { Calendar, SHARED_VALUE } from './shared.js';

export function createSecondaryCalendar(name) {
  return new Calendar(name);
}

export function getSharedValue() {
  return SHARED_VALUE;
}
