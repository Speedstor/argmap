import { execFileSync } from 'node:child_process';

export interface GitOptions {
  input?: string | Buffer;
  env?: Record<string, string>;
}

/** Run git in a folder and return its output. Throws if git fails. */
export function gitBuffer(root: string, args: string[], options: GitOptions = {}): Buffer {
  return execFileSync('git', ['-C', root, ...args], {
    input: options.input,
    env: { ...process.env, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function git(root: string, args: string[], options: GitOptions = {}): string {
  return gitBuffer(root, args, options).toString('utf8').trim();
}

/** Like git(), but returns undefined instead of throwing. */
export function tryGit(root: string, args: string[], options: GitOptions = {}): string | undefined {
  try {
    return git(root, args, options);
  } catch {
    return undefined;
  }
}

export function isRepo(root: string): boolean {
  return tryGit(root, ['rev-parse', '--git-dir']) !== undefined;
}

export function refExists(root: string, ref: string): boolean {
  return tryGit(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== undefined;
}
