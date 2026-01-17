// Entry that uses all locales
import { messages as en } from './locale-en.js';
import { messages as fr } from './locale-fr.js';

export const allLocales = {
  en,
  fr
};

export function getGreeting(lang) {
  return allLocales[lang]?.hello ?? 'Hello';
}
