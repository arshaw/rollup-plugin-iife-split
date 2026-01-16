/*
 * DEBUGGING TESTS
 *
 * To isolate a single test and inspect its output files:
 *
 * 1. Add .only to the test you want to run:
 *      it.only('should merge shared code...', async () => {
 *
 * 2. Add console.log to see the output directory:
 *      outputDir = result.outputDir;
 *      console.log('Output dir:', outputDir);
 *
 * 3. Comment out cleanup in afterEach below:
 *      // await cleanupBuild(outputDir);
 *
 * 4. Run the test:
 *      npm test -- -t "should merge"
 *
 * 5. Inspect the output:
 *      ls -la /var/folders/.../iife-split-test-xxx/
 *      cat /var/folders/.../iife-split-test-xxx/main.js
 */

import { describe, it, expect, afterEach } from 'vitest';
import { buildFixture, cleanupBuild, assertContains, assertNotContains, type BuildOptions } from './helpers.js';
import * as vm from 'vm';

describe('rollup-plugin-iife-split', () => {
  let outputDir: string | null = null;

  afterEach(async () => {
    if (outputDir) {
      await cleanupBuild(outputDir);
      outputDir = null;
    }
  });

  describe('basic two-entry bundle', () => {
    it('should merge shared code into primary entry', async () => {
      const result = await buildFixture('basic', {
        primary: 'main',
        primaryGlobal: 'MyLib',
        secondaryProps: { secondary: 'Secondary' },
        sharedProp: 'Shared'
      });
      outputDir = result.outputDir;

      const mainCode = result.files['main.js'];
      const secondaryCode = result.files['secondary.js'];

      // Primary should be an IIFE (var MyLib = ...)
      assertContains(mainCode, 'var MyLib', 'Primary should define global variable');
      assertContains(mainCode, '(function', 'Primary should be wrapped in IIFE');

      // Primary should contain the shared code
      assertContains(mainCode, 'sharedUtil', 'Primary should contain shared utility function');
      assertContains(mainCode, 'SHARED_CONSTANT', 'Primary should contain shared constant');

      // Primary should export Shared property
      assertContains(mainCode, 'Shared', 'Primary should expose shared exports');

      // Secondary should be an IIFE
      assertContains(secondaryCode, '(function', 'Secondary should be wrapped in IIFE');

      // Secondary should reference shared via global
      assertContains(secondaryCode, 'MyLib.Shared', 'Secondary should access shared code via global');
    });

    it('should NOT output a separate shared chunk file', async () => {
      const result = await buildFixture('basic', {
        primary: 'main',
        primaryGlobal: 'MyLib',
        secondaryProps: { secondary: 'Secondary' },
        sharedProp: 'Shared'
      });
      outputDir = result.outputDir;

      const fileNames = Object.keys(result.files);
      expect(fileNames).toContain('main.js');
      expect(fileNames).toContain('secondary.js');

      // Should not have a shared chunk file
      const hasSharedChunk = fileNames.some(f =>
        f.includes('shared') || f.includes('chunk')
      );
      expect(hasSharedChunk).toBe(false);
    });

    it('should only output entry files', async () => {
      const result = await buildFixture('basic', {
        primary: 'main',
        primaryGlobal: 'MyLib',
        secondaryProps: { secondary: 'Secondary' },
        sharedProp: 'Shared'
      });
      outputDir = result.outputDir;

      const fileNames = Object.keys(result.files);
      expect(fileNames.sort()).toEqual(['main.js', 'secondary.js']);
    });
  });

  describe('IIFE execution', () => {
    it('should produce executable primary code', async () => {
      const result = await buildFixture('basic', {
        primary: 'main',
        primaryGlobal: 'MyLib',
        secondaryProps: { secondary: 'Secondary' },
        sharedProp: 'Shared'
      });
      outputDir = result.outputDir;

      const mainCode = result.files['main.js'];

      // Execute in VM context
      const context: Record<string, unknown> = {};
      vm.runInNewContext(mainCode, context);

      // Verify exports
      expect(context.MyLib).toBeDefined();
      const myLib = context.MyLib as Record<string, unknown>;
      expect(typeof myLib.mainFeature).toBe('function');
      expect(myLib.MAIN_VERSION).toBe('1.0.0');

      // Verify shared exports (Rollup minifies names: sharedUtil → s, SHARED_CONSTANT → S)
      expect(myLib.Shared).toBeDefined();
      const shared = myLib.Shared as Record<string, unknown>;
      // Check that we have exports with minified names
      expect(typeof shared.s).toBe('function'); // sharedUtil
      expect(shared.S).toBe(42); // SHARED_CONSTANT

      // Test execution
      const mainFeature = myLib.mainFeature as () => string;
      const result2 = mainFeature();
      expect(result2).toContain('Main:');
      expect(result2).toContain('shared-value');
    });

    it('should produce executable satellite code that uses shared', async () => {
      const result = await buildFixture('basic', {
        primary: 'main',
        primaryGlobal: 'MyLib',
        secondaryProps: { secondary: 'Secondary' },
        sharedProp: 'Shared'
      });
      outputDir = result.outputDir;

      const mainCode = result.files['main.js'];
      const secondaryCode = result.files['secondary.js'];

      // Execute primary first to set up globals
      const context: Record<string, unknown> = {};
      vm.runInNewContext(mainCode, context);

      // Then execute secondary
      vm.runInNewContext(secondaryCode, context);

      // Verify secondary exports are attached to primary global (MyLib.Secondary)
      const myLib = context.MyLib as Record<string, unknown>;
      expect(myLib.Secondary).toBeDefined();
      const secondary = myLib.Secondary as Record<string, unknown>;
      expect(typeof secondary.secondaryFeature).toBe('function');

      // Test execution - should use shared code from primary
      const secondaryFeature = secondary.secondaryFeature as () => string;
      const result2 = secondaryFeature();
      expect(result2).toContain('Secondary:');
      expect(result2).toContain('shared-value');
    });
  });

  describe('error handling', () => {
    it('should throw if primary entry not found', async () => {
      await expect(
        buildFixture('basic', {
          primary: 'nonexistent',
          primaryGlobal: 'MyLib',
          secondaryProps: { secondary: 'Secondary' },
          sharedProp: 'Shared'
        })
      ).rejects.toThrow(/Primary entry "nonexistent" not found/);
    });
  });

  describe('no shared code scenario', () => {
    it('should handle entries with no shared dependencies', async () => {
      // Use only main entry (no secondary = nothing shared)
      const result = await buildFixture('basic', {
        primary: 'main',
        primaryGlobal: 'MyLib',
        secondaryProps: { secondary: 'Secondary' },
        sharedProp: 'Shared'
      }, ['main']);
      outputDir = result.outputDir;

      const mainCode = result.files['main.js'];

      // Should still be valid IIFE
      assertContains(mainCode, 'var MyLib', 'Should define global');
      assertContains(mainCode, '(function', 'Should be IIFE');

      // Execute and verify
      const context: Record<string, unknown> = {};
      vm.runInNewContext(mainCode, context);
      expect(context.MyLib).toBeDefined();
    });
  });

  describe('multiple shared modules', () => {
    it('should merge multiple shared modules into a single Shared object', async () => {
      const result = await buildFixture({
        fixtureName: 'multi-shared',
        pluginOptions: {
          primary: 'main',
          primaryGlobal: 'MyLib',
          secondaryProps: { pageA: 'PageA', pageB: 'PageB' },
          sharedProp: 'Shared'
        },
        entryNames: ['main', 'pageA', 'pageB']
      });
      outputDir = result.outputDir;

      const mainCode = result.files['main.js'];

      // Primary should contain code from both utils.js and helpers.js
      assertContains(mainCode, 'formatDate', 'Primary should contain formatDate from utils.js');
      assertContains(mainCode, 'capitalize', 'Primary should contain capitalize from helpers.js');

      // Primary should have the Shared object
      assertContains(mainCode, 'Shared', 'Primary should expose Shared exports');
    });

    it('should emit only entry files (3 files for 3 entries)', async () => {
      const result = await buildFixture({
        fixtureName: 'multi-shared',
        pluginOptions: {
          primary: 'main',
          primaryGlobal: 'MyLib',
          secondaryProps: { pageA: 'PageA', pageB: 'PageB' },
          sharedProp: 'Shared'
        },
        entryNames: ['main', 'pageA', 'pageB']
      });
      outputDir = result.outputDir;

      const fileNames = Object.keys(result.files).sort();

      // Should emit exactly 3 files - one for each entry
      expect(fileNames).toHaveLength(3);
      expect(fileNames).toEqual(['main.js', 'pageA.js', 'pageB.js']);

      // Should NOT have any chunk files
      const hasChunkFile = fileNames.some(f =>
        f.includes('chunk') || f.includes('__shared__')
      );
      expect(hasChunkFile).toBe(false);
    });

    it('should produce executable code with multiple shared modules', async () => {
      const result = await buildFixture({
        fixtureName: 'multi-shared',
        pluginOptions: {
          primary: 'main',
          primaryGlobal: 'MyLib',
          secondaryProps: { pageA: 'PageA', pageB: 'PageB' },
          sharedProp: 'Shared'
        },
        entryNames: ['main', 'pageA', 'pageB']
      });
      outputDir = result.outputDir;

      const mainCode = result.files['main.js'];
      const pageACode = result.files['pageA.js'];
      const pageBCode = result.files['pageB.js'];

      // Execute primary first
      const context: Record<string, unknown> = { Date };
      vm.runInNewContext(mainCode, context);

      // Verify primary works
      expect(context.MyLib).toBeDefined();
      const myLib = context.MyLib as Record<string, unknown>;
      expect(typeof myLib.mainFeature).toBe('function');
      expect(myLib.Shared).toBeDefined();

      // Execute satellites
      vm.runInNewContext(pageACode, context);
      vm.runInNewContext(pageBCode, context);

      // Verify satellites are attached to primary global (MyLib.PageA, MyLib.PageB)
      expect(myLib.PageA).toBeDefined();
      expect(myLib.PageB).toBeDefined();

      const pageA = myLib.PageA as Record<string, unknown>;
      const pageB = myLib.PageB as Record<string, unknown>;
      expect(typeof pageA.pageAFeature).toBe('function');
      expect(typeof pageB.pageBFeature).toBe('function');

      // Test execution - functions should work using shared code
      const mainFeature = myLib.mainFeature as () => string;
      const mainResult = mainFeature();
      expect(mainResult).toMatch(/Main:/i);

      const pageAFeature = pageA.pageAFeature as () => string;
      const pageAResult = pageAFeature();
      expect(pageAResult).toMatch(/Page-a:/i);

      const pageBFeature = pageB.pageBFeature as () => string;
      const pageBResult = pageBFeature();
      expect(pageBResult).toMatch(/Page-b:/i);
    });

    it('should have all shared exports accessible via MyLib.Shared', async () => {
      const result = await buildFixture({
        fixtureName: 'multi-shared',
        pluginOptions: {
          primary: 'main',
          primaryGlobal: 'MyLib',
          secondaryProps: { pageA: 'PageA', pageB: 'PageB' },
          sharedProp: 'Shared'
        },
        entryNames: ['main', 'pageA', 'pageB']
      });
      outputDir = result.outputDir;

      const mainCode = result.files['main.js'];

      // Execute primary
      const context: Record<string, unknown> = { Date };
      vm.runInNewContext(mainCode, context);

      const myLib = context.MyLib as Record<string, unknown>;
      const shared = myLib.Shared as Record<string, unknown>;

      // Shared should have exports from both utils.js and helpers.js
      // Note: Rollup minifies export names, so we check that Shared has multiple properties
      const sharedKeys = Object.keys(shared);
      expect(sharedKeys.length).toBeGreaterThanOrEqual(2);

      // At least some exports should be functions (formatDate, capitalize, etc.)
      const hasFunctions = Object.values(shared).some(v => typeof v === 'function');
      expect(hasFunctions).toBe(true);
    });
  });

  describe('user-supplied output options', () => {
    it('should work with output options as array (multiple outputs)', async () => {
      const result = await buildFixture({
        fixtureName: 'basic',
        pluginOptions: {
          primary: 'main',
          primaryGlobal: 'MyLib',
          secondaryProps: { secondary: 'Secondary' },
          sharedProp: 'Shared'
        },
        outputOptions: [
          {
            format: 'es',
            entryFileNames: '[name].js'
          },
          {
            format: 'es',
            entryFileNames: '[name].min.js'
          }
        ]
      });
      outputDir = result.outputDir;

      const fileNames = Object.keys(result.files).sort();

      // Should have both regular and .min.js files
      expect(fileNames).toContain('main.js');
      expect(fileNames).toContain('main.min.js');
      expect(fileNames).toContain('secondary.js');
      expect(fileNames).toContain('secondary.min.js');
    });

    it('should pass through rollupOptions to rollup', async () => {
      const result = await buildFixture({
        fixtureName: 'basic',
        pluginOptions: {
          primary: 'main',
          primaryGlobal: 'MyLib',
          secondaryProps: { secondary: 'Secondary' },
          sharedProp: 'Shared'
        },
        rollupOptions: {
          external: ['lodash']
        }
      });
      outputDir = result.outputDir;

      // Should build successfully with rollupOptions passed through
      expect(result.files['main.js']).toBeDefined();
    });
  });

  describe('secondaryProps', () => {
    it('should attach secondary entries as properties on the primary global', async () => {
      const result = await buildFixture('basic', {
        primary: 'main',
        primaryGlobal: 'MyLib',
        secondaryProps: { secondary: 'Secondary' },
        sharedProp: 'Shared'
      });
      outputDir = result.outputDir;

      const secondaryCode = result.files['secondary.js'];

      // Secondary should assign to MyLib.Secondary, not a top-level var
      assertContains(secondaryCode, 'MyLib.Secondary', 'Secondary should be assigned to MyLib.Secondary');
    });

    it('should support custom property names different from entry names', async () => {
      const result = await buildFixture('basic', {
        primary: 'main',
        primaryGlobal: 'MyLib',
        secondaryProps: { secondary: 'Alt' },
        sharedProp: 'Shared'
      });
      outputDir = result.outputDir;

      const mainCode = result.files['main.js'];
      const secondaryCode = result.files['secondary.js'];

      // Execute and verify
      const context: Record<string, unknown> = {};
      vm.runInNewContext(mainCode, context);
      vm.runInNewContext(secondaryCode, context);

      const myLib = context.MyLib as Record<string, unknown>;
      expect(myLib.Alt).toBeDefined();
      const alt = myLib.Alt as Record<string, unknown>;
      expect(typeof alt.secondaryFeature).toBe('function');
    });

    it('should throw if secondary entry is not in secondaryProps', async () => {
      await expect(
        buildFixture('basic', {
          primary: 'main',
          primaryGlobal: 'MyLib',
          secondaryProps: {}, // Missing 'secondary' entry
          sharedProp: 'Shared'
        })
      ).rejects.toThrow(/Secondary entry "secondary" not found in secondaryProps/);
    });

    it('should support multiple secondary entries with different property names', async () => {
      const result = await buildFixture({
        fixtureName: 'multi-shared',
        pluginOptions: {
          primary: 'main',
          primaryGlobal: 'App',
          secondaryProps: { pageA: 'Admin', pageB: 'Dashboard' },
          sharedProp: 'Core'
        },
        entryNames: ['main', 'pageA', 'pageB']
      });
      outputDir = result.outputDir;

      const mainCode = result.files['main.js'];
      const pageACode = result.files['pageA.js'];
      const pageBCode = result.files['pageB.js'];

      // Execute all
      const context: Record<string, unknown> = { Date };
      vm.runInNewContext(mainCode, context);
      vm.runInNewContext(pageACode, context);
      vm.runInNewContext(pageBCode, context);

      // Verify structure: App.Admin, App.Dashboard, App.Core
      const app = context.App as Record<string, unknown>;
      expect(app).toBeDefined();
      expect(app.Admin).toBeDefined();
      expect(app.Dashboard).toBeDefined();
      expect(app.Core).toBeDefined();

      // Verify functions work
      const admin = app.Admin as Record<string, unknown>;
      const dashboard = app.Dashboard as Record<string, unknown>;
      expect(typeof admin.pageAFeature).toBe('function');
      expect(typeof dashboard.pageBFeature).toBe('function');
    });

    it('should allow omitting entries with no exports from secondaryProps', async () => {
      // The 'init' entry has no exports - just side effects
      // It doesn't need to be in secondaryProps
      const result = await buildFixture({
        fixtureName: 'side-effects',
        pluginOptions: {
          primary: 'main',
          primaryGlobal: 'MyLib',
          secondaryProps: {}, // No secondary entries with exports
          sharedProp: 'Shared'
        },
        entryNames: ['main', 'init']
      });
      outputDir = result.outputDir;

      const mainCode = result.files['main.js'];
      const initCode = result.files['init.js'];

      // Both files should exist and be valid IIFEs
      expect(mainCode).toBeDefined();
      expect(initCode).toBeDefined();

      // Primary should be an IIFE with a global
      assertContains(mainCode, 'var MyLib', 'Primary should define global variable');
      assertContains(mainCode, '(function', 'Primary should be wrapped in IIFE');

      // Init (side-effects only) should be an IIFE without a global assignment
      assertContains(initCode, '(function', 'Init should be wrapped in IIFE');

      // Execute both - they should run without error
      const context: Record<string, unknown> = {};
      vm.runInNewContext(mainCode, context);
      vm.runInNewContext(initCode, context);

      // Verify primary works
      const myLib = context.MyLib as Record<string, unknown>;
      expect(myLib).toBeDefined();
      expect(typeof myLib.mainFeature).toBe('function');
    });
  });
});
