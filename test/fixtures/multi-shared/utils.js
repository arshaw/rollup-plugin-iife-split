export function formatDate(date) {
  return date.toISOString().split('T')[0];
}

export function formatTime(date) {
  return date.toISOString().split('T')[1];
}

export const VERSION = '1.0.0';
