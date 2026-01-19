// Base class that will be imported with an alias due to name collision
export class Calendar {
  constructor(name) {
    this.name = name;
  }

  getName() {
    return `Base: ${this.name}`;
  }
}

export const SHARED_VALUE = 'shared';
