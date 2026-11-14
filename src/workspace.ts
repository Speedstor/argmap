import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { load } from './index.ts';
import type { LibrarySource, Loaded } from './index.ts';

export const LIBRARY_DIR = 'claims';
export const ARGUMENTS_DIR = 'arguments';

/** The nearest folder above a file that holds a claims library, or the file's own folder. */
export function findRoot(from: string): string {
  let dir = resolve(from);
  if (existsSync(dir) && !statSync(dir).isDirectory()) dir = dirname(dir);
  const start = dir;
  for (;;) {
    if (existsSync(join(dir, LIBRARY_DIR)) && statSync(join(dir, LIBRARY_DIR)).isDirectory()) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

function yamlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => join(dir, name))
    .sort();
}

export function libraryFiles(root: string): string[] {
  return yamlFiles(join(root, LIBRARY_DIR));
}

export function argumentFiles(root: string): string[] {
  return yamlFiles(join(root, ARGUMENTS_DIR));
}

export function readLibrary(root: string): LibrarySource[] {
  return libraryFiles(root).map((path) => ({
    name: relative(root, path).split(sep).join('/'),
    source: readFileSync(path, 'utf8'),
  }));
}

export interface LoadedFile extends Loaded {
  root: string;
  path: string;
  source: string;
  library: LibrarySource[];
}

/** Load an argument file together with the claims library of the workspace it sits in. */
export function loadFile(path: string, root = findRoot(path)): LoadedFile {
  const source = readFileSync(path, 'utf8');
  const library = readLibrary(root);
  return { ...load(source, library), root, path: resolve(path), source, library };
}
