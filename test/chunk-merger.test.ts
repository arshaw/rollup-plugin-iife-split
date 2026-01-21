import { describe, it, expect } from 'vitest';
import { parse } from 'acorn';
import type { OutputChunk } from 'rollup';
import { mergeSharedIntoPrimary, extractSharedImports } from '../src/chunk-merger';
import type { Program } from 'estree';

// Create a parse function compatible with the merger's ParseFn type
function createParseFn() {
  return (code: string): Program => {
    return parse(code, { ecmaVersion: 'latest', sourceType: 'module' }) as unknown as Program;
  };
}

// Helper to create a minimal OutputChunk for testing
function createChunk(name: string, code: string, fileName?: string): OutputChunk {
  return {
    name,
    fileName: fileName ?? `${name}.js`,
    code,
    type: 'chunk',
    isEntry: true,
    isDynamicEntry: false,
    facadeModuleId: null,
    exports: [],
    imports: [],
    implicitlyLoadedBefore: [],
    importedBindings: {},
    modules: {},
    referencedFiles: [],
    dynamicImports: [],
    map: null,
    preliminaryFileName: `${name}.js`,
    sourcemapFileName: null,
    moduleIds: []
  };
}

describe('chunk-merger', () => {
  describe('mergeSharedIntoPrimary', () => {
    const parseFn = createParseFn();

    it('should merge shared code into primary', () => {
      const primaryChunk = createChunk('main', `
import { helper } from './__shared__.js';

export function mainFeature() {
  return helper();
}
`);

      const sharedChunk = createChunk('__shared__', `
export function helper() {
  return 'helper-result';
}
`);

      const neededExports = new Set(['helper']);

      mergeSharedIntoPrimary(primaryChunk, sharedChunk, 'Shared', neededExports, parseFn);

      // Shared code should be in the output
      expect(primaryChunk.code).toContain('function helper()');
      expect(primaryChunk.code).toContain("'helper-result'");

      // Import from shared should be removed
      expect(primaryChunk.code).not.toContain("from './__shared__");

      // Shared export object should be created
      expect(primaryChunk.code).toContain('const Shared = { helper }');
      expect(primaryChunk.code).toContain('export { Shared }');
    });

    it('should rename shared declarations that collide with primary declarations', () => {
      const primaryChunk = createChunk('main', `
import { sharedHelper } from './__shared__.js';

const helper = 'primary-helper';

export function mainFeature() {
  return helper + ' ' + sharedHelper();
}
`);

      const sharedChunk = createChunk('__shared__', `
const helper = 'shared-internal';

export function sharedHelper() {
  return helper;
}
`);

      const neededExports = new Set(['sharedHelper']);

      mergeSharedIntoPrimary(primaryChunk, sharedChunk, 'Shared', neededExports, parseFn);

      // Both helpers should exist, shared one renamed
      expect(primaryChunk.code).toContain("const helper = 'primary-helper'");
      expect(primaryChunk.code).toContain("const __shared$helper = 'shared-internal'");

      // References in shared code should be updated
      expect(primaryChunk.code).toContain('return __shared$helper');
    });

    it('should rename shared declarations that collide with primary external imports', () => {
      // This is the bug scenario: primary imports a name from external package,
      // shared has a local variable with the same name
      const primaryChunk = createChunk('main', `
import { globalPlugins } from '@fullcalendar/core';

export function mainFeature() {
  globalPlugins.push('my-plugin');
  return useShared();
}

import { useShared } from './__shared__.js';
`);

      const sharedChunk = createChunk('__shared__', `
const globalPlugins = ['default-plugin'];

export function useShared() {
  return globalPlugins.join(',');
}
`);

      const neededExports = new Set(['useShared']);

      mergeSharedIntoPrimary(primaryChunk, sharedChunk, 'Shared', neededExports, parseFn);

      // The shared chunk's globalPlugins should be renamed to avoid collision
      expect(primaryChunk.code).toContain("const __shared$globalPlugins = ['default-plugin']");

      // The external import should still exist
      expect(primaryChunk.code).toContain("import { globalPlugins } from '@fullcalendar/core'");

      // Primary code should still use the external globalPlugins
      expect(primaryChunk.code).toContain("globalPlugins.push('my-plugin')");

      // Shared code references should use the renamed variable
      expect(primaryChunk.code).toContain('return __shared$globalPlugins.join');
    });

    it('should handle multiple external import collisions', () => {
      const primaryChunk = createChunk('main', `
import { createPlugin, joinClassNames } from '@fullcalendar/core';
import { helper } from './__shared__.js';

export function mainFeature() {
  return createPlugin() + joinClassNames('a', 'b') + helper();
}
`);

      const sharedChunk = createChunk('__shared__', `
const createPlugin = () => 'shared-plugin';
const joinClassNames = (...names) => names.join('-');
const internalOnly = 'no-collision';

export function helper() {
  return createPlugin() + joinClassNames('x', 'y') + internalOnly;
}
`);

      const neededExports = new Set(['helper']);

      mergeSharedIntoPrimary(primaryChunk, sharedChunk, 'Shared', neededExports, parseFn);

      // Both colliding declarations should be renamed
      expect(primaryChunk.code).toContain("const __shared$createPlugin = () => 'shared-plugin'");
      expect(primaryChunk.code).toContain('const __shared$joinClassNames = (...names) => names.join');

      // Non-colliding declaration should NOT be renamed
      expect(primaryChunk.code).toContain("const internalOnly = 'no-collision'");

      // References in shared code should be updated
      expect(primaryChunk.code).toContain('return __shared$createPlugin() + __shared$joinClassNames');
    });

    it('should handle namespace imports from external packages', () => {
      const primaryChunk = createChunk('main', `
import * as utils from 'lodash';
import { helper } from './__shared__.js';

export function mainFeature() {
  return utils.get({}, 'path') + helper();
}
`);

      const sharedChunk = createChunk('__shared__', `
const utils = { internal: true };

export function helper() {
  return utils.internal;
}
`);

      const neededExports = new Set(['helper']);

      mergeSharedIntoPrimary(primaryChunk, sharedChunk, 'Shared', neededExports, parseFn);

      // The shared utils should be renamed
      expect(primaryChunk.code).toContain('const __shared$utils = { internal: true }');

      // External namespace import should still work
      expect(primaryChunk.code).toContain("import * as utils from 'lodash'");

      // Primary code references external utils
      expect(primaryChunk.code).toContain("utils.get({}, 'path')");

      // Shared code references renamed utils
      expect(primaryChunk.code).toContain('__shared$utils.internal');
    });

    it('should handle default imports from external packages', () => {
      const primaryChunk = createChunk('main', `
import React from 'react';
import { helper } from './__shared__.js';

export function Component() {
  return React.createElement('div', null, helper());
}
`);

      const sharedChunk = createChunk('__shared__', `
const React = { version: 'fake' };

export function helper() {
  return React.version;
}
`);

      const neededExports = new Set(['helper']);

      mergeSharedIntoPrimary(primaryChunk, sharedChunk, 'Shared', neededExports, parseFn);

      // The shared React should be renamed
      expect(primaryChunk.code).toContain("const __shared$React = { version: 'fake' }");

      // External default import should still work
      expect(primaryChunk.code).toContain("import React from 'react'");

      // References should be correctly updated
      expect(primaryChunk.code).toContain('__shared$React.version');
    });

    it('should not rename when there is no collision', () => {
      const primaryChunk = createChunk('main', `
import { externalFn } from 'external-lib';
import { sharedFn } from './__shared__.js';

export function mainFeature() {
  return externalFn() + sharedFn();
}
`);

      const sharedChunk = createChunk('__shared__', `
const internalHelper = 'no-collision';

export function sharedFn() {
  return internalHelper;
}
`);

      const neededExports = new Set(['sharedFn']);

      mergeSharedIntoPrimary(primaryChunk, sharedChunk, 'Shared', neededExports, parseFn);

      // No renaming should occur
      expect(primaryChunk.code).toContain("const internalHelper = 'no-collision'");
      expect(primaryChunk.code).not.toContain('__shared$');
    });

    it('should only export needed symbols in Shared object', () => {
      const primaryChunk = createChunk('main', `
import { usedByPrimary, usedBySatellite } from './__shared__.js';

export function mainFeature() {
  return usedByPrimary();
}
`);

      const sharedChunk = createChunk('__shared__', `
export function usedByPrimary() {
  return 'primary';
}

export function usedBySatellite() {
  return 'satellite';
}

export function unusedExport() {
  return 'unused';
}
`);

      // Only usedBySatellite is needed (primary uses its own merged copy)
      const neededExports = new Set(['usedBySatellite']);

      mergeSharedIntoPrimary(primaryChunk, sharedChunk, 'Shared', neededExports, parseFn);

      // Shared object should only include needed exports
      expect(primaryChunk.code).toContain('const Shared = { usedBySatellite }');
      expect(primaryChunk.code).not.toMatch(/Shared.*usedByPrimary/);
      expect(primaryChunk.code).not.toMatch(/Shared.*unusedExport/);
    });

    it('should handle exported function with collision', () => {
      const primaryChunk = createChunk('main', `
import { formatDate } from 'date-fns';
import { formatDate as sharedFormatDate } from './__shared__.js';

export function mainFeature() {
  return formatDate(new Date(), 'yyyy') + sharedFormatDate('test');
}
`);

      const sharedChunk = createChunk('__shared__', `
export function formatDate(value) {
  return 'formatted: ' + value;
}
`);

      const neededExports = new Set(['formatDate']);

      mergeSharedIntoPrimary(primaryChunk, sharedChunk, 'Shared', neededExports, parseFn);

      // The shared formatDate should be renamed due to collision with external import
      expect(primaryChunk.code).toContain('function __shared$formatDate(value)');

      // External import should remain
      expect(primaryChunk.code).toContain("import { formatDate } from 'date-fns'");

      // The Shared export should map to the renamed function
      expect(primaryChunk.code).toContain('formatDate: __shared$formatDate');
    });

    it('should handle class declarations with collision', () => {
      const primaryChunk = createChunk('main', `
import { Calendar } from '@fullcalendar/core';
import { getCalendar } from './__shared__.js';

export function mainFeature() {
  return new Calendar().render() + getCalendar();
}
`);

      const sharedChunk = createChunk('__shared__', `
class Calendar {
  constructor() {
    this.name = 'SharedCalendar';
  }
}

export function getCalendar() {
  return new Calendar().name;
}
`);

      const neededExports = new Set(['getCalendar']);

      mergeSharedIntoPrimary(primaryChunk, sharedChunk, 'Shared', neededExports, parseFn);

      // The shared Calendar class should be renamed
      expect(primaryChunk.code).toContain('class __shared$Calendar');

      // References to Calendar in shared code should be updated
      expect(primaryChunk.code).toContain('new __shared$Calendar()');

      // External import should remain
      expect(primaryChunk.code).toContain("import { Calendar } from '@fullcalendar/core'");
    });

    it('should rename shared external import that collides with primary declaration', () => {
      // Bug scenario: shared imports a name from external package,
      // but primary has a local function with the same name
      const primaryChunk = createChunk('main', `
import { useShared } from './__shared__.js';

function parseBusinessHours(input, context) {
  return 'local: ' + input;
}

export function mainFeature() {
  return parseBusinessHours('test') + useShared();
}
`);

      const sharedChunk = createChunk('__shared__', `
import { parseBusinessHours } from '@fullcalendar/preact/protected-api';

export function useShared() {
  return parseBusinessHours('shared-input');
}
`);

      const neededExports = new Set(['useShared']);

      mergeSharedIntoPrimary(primaryChunk, sharedChunk, 'Shared', neededExports, parseFn);

      // The shared's external import binding should be renamed to avoid collision
      expect(primaryChunk.code).toContain(
        "import { parseBusinessHours as __shared$parseBusinessHours } from '@fullcalendar/preact/protected-api'"
      );

      // Primary's local function should remain unchanged
      expect(primaryChunk.code).toContain("function parseBusinessHours(input, context)");

      // Shared code should reference the renamed import
      expect(primaryChunk.code).toContain("__shared$parseBusinessHours('shared-input')");

      // Primary code should still use its local function
      expect(primaryChunk.code).toContain("parseBusinessHours('test')");

      // Should NOT have duplicate identifier error (both names coexist)
      const parseBusinessHoursCount = (primaryChunk.code.match(/function parseBusinessHours\(/g) || []).length;
      expect(parseBusinessHoursCount).toBe(1); // Only the primary's function declaration
    });

    it('should rename shared external import with alias that collides with primary declaration', () => {
      // The shared chunk imports with an alias that happens to match a primary declaration
      const primaryChunk = createChunk('main', `
import { useShared } from './__shared__.js';

const helper = 'primary-helper';

export function mainFeature() {
  return helper + useShared();
}
`);

      const sharedChunk = createChunk('__shared__', `
import { someFunction as helper } from 'external-lib';

export function useShared() {
  return helper();
}
`);

      const neededExports = new Set(['useShared']);

      mergeSharedIntoPrimary(primaryChunk, sharedChunk, 'Shared', neededExports, parseFn);

      // The shared's import alias should be renamed
      expect(primaryChunk.code).toContain(
        "import { someFunction as __shared$helper } from 'external-lib'"
      );

      // Primary's local const should remain unchanged
      expect(primaryChunk.code).toContain("const helper = 'primary-helper'");

      // Shared code should reference the renamed alias
      expect(primaryChunk.code).toContain('__shared$helper()');
    });

    it('should rename shared external import that collides with primary external import from different source', () => {
      // Both chunks import the same local name from DIFFERENT packages
      const primaryChunk = createChunk('main', `
import dayGridPlugin from '@fullcalendar/web-component/daygrid';
import { useShared } from './__shared__.js';

export function mainFeature() {
  return dayGridPlugin.name + useShared();
}
`);

      const sharedChunk = createChunk('__shared__', `
import dayGridPlugin from '@fullcalendar/preact/daygrid';

export function useShared() {
  return dayGridPlugin.version;
}
`);

      const neededExports = new Set(['useShared']);

      mergeSharedIntoPrimary(primaryChunk, sharedChunk, 'Shared', neededExports, parseFn);

      // The shared's default import should be renamed
      expect(primaryChunk.code).toContain(
        "import { default as __shared$dayGridPlugin } from '@fullcalendar/preact/daygrid'"
      );

      // Primary's import should remain unchanged
      expect(primaryChunk.code).toContain("import dayGridPlugin from '@fullcalendar/web-component/daygrid'");

      // Primary code should use its own dayGridPlugin
      expect(primaryChunk.code).toContain('dayGridPlugin.name');

      // Shared code should reference the renamed import
      expect(primaryChunk.code).toContain('__shared$dayGridPlugin.version');
    });

    it('should rename shared named import that collides with primary named import from different source', () => {
      // Both chunks import the same named export from DIFFERENT packages
      const primaryChunk = createChunk('main', `
import { formatDate } from 'date-fns';
import { useShared } from './__shared__.js';

export function mainFeature() {
  return formatDate(new Date(), 'yyyy') + useShared();
}
`);

      const sharedChunk = createChunk('__shared__', `
import { formatDate } from 'moment';

export function useShared() {
  return formatDate('YYYY');
}
`);

      const neededExports = new Set(['useShared']);

      mergeSharedIntoPrimary(primaryChunk, sharedChunk, 'Shared', neededExports, parseFn);

      // The shared's import should be renamed
      expect(primaryChunk.code).toContain(
        "import { formatDate as __shared$formatDate } from 'moment'"
      );

      // Primary's import should remain unchanged
      expect(primaryChunk.code).toContain("import { formatDate } from 'date-fns'");

      // Shared code should reference the renamed import
      expect(primaryChunk.code).toContain("__shared$formatDate('YYYY')");
    });
  });

  describe('extractSharedImports', () => {
    const parseFn = createParseFn();

    it('should extract named imports from shared chunk', () => {
      const code = `
import { foo, bar as baz } from './__shared__.js';
import { other } from 'external';

export function test() {
  return foo() + baz();
}
`;

      const imports = extractSharedImports(code, '__shared__.js', parseFn);

      expect(imports.has('foo')).toBe(true);
      expect(imports.has('bar')).toBe(true); // The imported name, not the alias
      expect(imports.has('baz')).toBe(false); // Alias is not tracked
      expect(imports.has('other')).toBe(false); // From different source
    });

    it('should extract default import from shared chunk', () => {
      const code = `
import shared from './__shared__.js';

export function test() {
  return shared.something;
}
`;

      const imports = extractSharedImports(code, '__shared__.js', parseFn);

      expect(imports.has('default')).toBe(true);
    });

    it('should handle multiple import statements from shared', () => {
      const code = `
import { foo } from './__shared__.js';
import { bar, baz } from './__shared__.js';

export function test() {
  return foo() + bar() + baz();
}
`;

      const imports = extractSharedImports(code, '__shared__.js', parseFn);

      expect(imports.has('foo')).toBe(true);
      expect(imports.has('bar')).toBe(true);
      expect(imports.has('baz')).toBe(true);
    });
  });
});
