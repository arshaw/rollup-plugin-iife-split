// Entry that uses only English locale
import { messages } from './locale-en.js';

export function greet() {
  return messages.hello;
}

export function farewell() {
  return messages.goodbye;
}
