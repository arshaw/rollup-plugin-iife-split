import { Widget, VERSION } from './shared.js';

export function createSecondaryWidget(name) {
  return new Widget(name);
}

export function getVersion() {
  return VERSION;
}
