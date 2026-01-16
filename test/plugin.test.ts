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
        globalName: 'MyLib',
        sharedProperty: 'Shared'
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
        globalName: 'MyLib',
        sharedProperty: 'Shared'
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
        globalName: 'MyLib',
        sharedProperty: 'Shared'
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
        globalName: 'MyLib',
        sharedProperty: 'Shared'
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
        globalName: 'MyLib',
        sharedProperty: 'Shared'
      });
      outputDir = result.outputDir;

      const mainCode = result.files['main.js'];
      const secondaryCode = result.files['secondary.js'];

      // Execute primary first to set up globals
      const context: Record<string, unknown> = {};
      vm.runInNewContext(mainCode, context);

      // Then execute secondary
      vm.runInNewContext(secondaryCode, context);

      // Verify secondary exports
      expect(context.Secondary).toBeDefined();
      const secondary = context.Secondary as Record<string, unknown>;
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
          globalName: 'MyLib',
          sharedProperty: 'Shared'
        })
      ).rejects.toThrow(/Primary entry "nonexistent" not found/);
    });
  });

  describe('no shared code scenario', () => {
    it('should handle entries with no shared dependencies', async () => {
      // Use only main entry (no secondary = nothing shared)
      const result = await buildFixture('basic', {
        primary: 'main',
        globalName: 'MyLib',
        sharedProperty: 'Shared'
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
          globalName: 'MyLib',
          sharedProperty: 'Shared'
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
          globalName: 'MyLib',
          sharedProperty: 'Shared'
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
          globalName: 'MyLib',
          sharedProperty: 'Shared'
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

      // Verify satellites work and use shared code
      expect(context.PageA).toBeDefined();
      expect(context.PageB).toBeDefined();

      const pageA = context.PageA as Record<string, unknown>;
      const pageB = context.PageB as Record<string, unknown>;
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
          globalName: 'MyLib',
          sharedProperty: 'Shared'
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
          globalName: 'MyLib',
          sharedProperty: 'Shared'
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
          globalName: 'MyLib',
          sharedProperty: 'Shared'
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
});
