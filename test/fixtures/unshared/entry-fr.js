// Entry that uses only French locale
import { messages } from './locale-fr.js';

export function greet() {
  return messages.hello;
}

export function farewell() {
  return messages.goodbye;
}
