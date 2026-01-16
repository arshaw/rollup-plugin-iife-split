import { rollup, type OutputOptions, type RollupOptions } from 'rollup';
import iifeSplit, { type IifeSplitOptions } from '../src/index.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface BuildResult {
  outputDir: string;
  files: Record<string, string>;
}

export interface BuildOptions {
  fixtureName: string;
  pluginOptions: IifeSplitOptions;
  entryNames?: string[];
  outputOptions?: OutputOptions | OutputOptions[];
  rollupOptions?: Partial<RollupOptions>;
}

export async function buildFixture(
  fixtureName: string,
  pluginOptions: IifeSplitOptions,
  entryNames?: string[]
): Promise<BuildResult>;
export async function buildFixture(options: BuildOptions): Promise<BuildResult>;
export async function buildFixture(
  fixtureNameOrOptions: string | BuildOptions,
  pluginOptions?: IifeSplitOptions,
  entryNames?: string[]
): Promise<BuildResult> {
  // Handle overloaded signatures
  let options: BuildOptions;
  if (typeof fixtureNameOrOptions === 'string') {
    options = {
      fixtureName: fixtureNameOrOptions,
      pluginOptions: pluginOptions!,
      entryNames
    };
  } else {
    options = fixtureNameOrOptions;
  }

  const fixtureDir = path.join(__dirname, 'fixtures', options.fixtureName);
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iife-split-test-'));

  // Determine entry points
  let input: Record<string, string>;

  if (options.entryNames) {
    // Use specified entry names
    input = {};
    for (const name of options.entryNames) {
      input[name] = path.join(fixtureDir, `${name}.js`);
    }
  } else {
    // Auto-discover: use all .js files except known shared modules as entries
    const inputFiles = await fs.readdir(fixtureDir);
    const sharedFiles = ['shared.js', 'utils.js', 'helpers.js'];
    input = {};
    for (const file of inputFiles) {
      if (file.endsWith('.js') && !sharedFiles.includes(file)) {
        const name = path.basename(file, '.js');
        input[name] = path.join(fixtureDir, file);
      }
    }
  }

  const bundle = await rollup({
    input,
    plugins: [iifeSplit(options.pluginOptions)],
    ...options.rollupOptions
  });

  // Handle output options - can be single object or array
  const outputOptionsList = options.outputOptions
    ? (Array.isArray(options.outputOptions) ? options.outputOptions : [options.outputOptions])
    : [{ format: 'es' as const }];

  for (const outputOpts of outputOptionsList) {
    await bundle.write({
      dir: outputDir,
      ...outputOpts
    });
  }

  await bundle.close();

  // Read all output files
  const outputFiles = await fs.readdir(outputDir);
  const files: Record<string, string> = {};

  for (const file of outputFiles) {
    files[file] = await fs.readFile(path.join(outputDir, file), 'utf-8');
  }

  return { outputDir, files };
}

export async function cleanupBuild(outputDir: string): Promise<void> {
  await fs.rm(outputDir, { recursive: true, force: true });
}

export function assertContains(
  code: string,
  pattern: string | RegExp,
  message?: string
): void {
  const found = typeof pattern === 'string'
    ? code.includes(pattern)
    : pattern.test(code);

  if (!found) {
    throw new Error(message || `Expected code to contain: ${pattern}\n\nActual code:\n${code.slice(0, 500)}...`);
  }
}

export function assertNotContains(
  code: string,
  pattern: string | RegExp,
  message?: string
): void {
  const found = typeof pattern === 'string'
    ? code.includes(pattern)
    : pattern.test(code);

  if (found) {
    throw new Error(message || `Expected code NOT to contain: ${pattern}`);
  }
}
