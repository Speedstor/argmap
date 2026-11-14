import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, isRepo, refExists, tryGit } from './git.ts';
import type { Argument } from './types.ts';

export const IDEAS_BRANCH = 'ideas';
export const IDEAS_DIR = 'ideas';

export type Scope = 'argument' | 'claim';

/** One note on a notepad. Notes are loose thinking; they never affect a verdict. */
export interface Idea {
  text: string;
  /** True when the note sits in the notepad's closing "Related ideas" list. */
  related: boolean;
  /** Claim ids the note mentions as [[claim-id]]. */
  mentions: string[];
  by?: string;
  date?: string;
}

export interface Notepad {
  path: string;
  scope: Scope;
  /** The argument's file name without extension, or the claim id. */
  name: string;
  title: string;
  ideas: Idea[];
}

export class IdeasError extends Error {}

const RELATED_HEADING = '## Related ideas';
const NOTES_HEADING = '## Notes';

export function notepadPath(scope: Scope, name: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new IdeasError(`"${name}" is not a usable notepad name.`);
  return scope === 'claim' ? `${IDEAS_DIR}/claims/${name}.md` : `${IDEAS_DIR}/${name}.md`;
}

function scopeOf(path: string): { scope: Scope; name: string } | undefined {
  const claim = /^ideas\/claims\/([a-z0-9][a-z0-9-]*)\.md$/.exec(path);
  if (claim) return { scope: 'claim', name: claim[1] as string };
  const argument = /^ideas\/([a-z0-9][a-z0-9-]*)\.md$/.exec(path);
  if (argument) return { scope: 'argument', name: argument[1] as string };
  return undefined;
}

/** Read a notepad. Any list item or paragraph under a heading is a note. */
export function parseNotepad(path: string, text: string): Notepad | undefined {
  const where = scopeOf(path);
  if (!where) return undefined;
  let title = where.name;
  let related = false;
  let inSection = false;
  const ideas: Idea[] = [];
  let current: string[] | undefined;
  let currentRelated = false;
  const flush = (): void => {
    if (!current) return;
    let body = current.join(' ').replace(/\s+/g, ' ').trim();
    current = undefined;
    if (body === '') return;
    const idea: Idea = { text: body, related: currentRelated, mentions: [] };
    const tail = /\s*\(([^(),]+),\s*(\d{4}-\d{2}-\d{2})\)$/.exec(body);
    if (tail) {
      idea.by = (tail[1] as string).trim();
      idea.date = tail[2] as string;
      body = body.slice(0, tail.index).trim();
      idea.text = body;
    }
    idea.mentions = [...new Set([...body.matchAll(/\[\[([a-z0-9][a-z0-9-]*)\]\]/g)].map((m) => m[1] as string))];
    if (where.scope === 'claim' && !idea.mentions.includes(where.name)) idea.mentions.push(where.name);
    ideas.push(idea);
  };
  for (const line of text.split(/\r?\n/)) {
    const heading = /^(#+)\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      if ((heading[1] as string).length === 1) {
        title = (heading[2] as string).replace(/^Notepad:\s*/i, '').trim();
        continue;
      }
      inSection = true;
      related = /^related ideas$/i.test((heading[2] as string).trim());
      continue;
    }
    if (!inSection) continue;
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (item) {
      flush();
      current = [item[1] as string];
      currentRelated = related;
    } else if (line.trim() === '') {
      flush();
    } else if (current) {
      current.push(line.trim());
    } else {
      current = [line.trim()];
      currentRelated = related;
    }
  }
  flush();
  return { path, ...where, title, ideas };
}

/** The ideas branch to read: the local one, unless the remote has moved ahead of it. */
function ideasRef(root: string): string | undefined {
  const local = `refs/heads/${IDEAS_BRANCH}`;
  const remote = `refs/remotes/origin/${IDEAS_BRANCH}`;
  const hasLocal = refExists(root, local);
  const hasRemote = refExists(root, remote);
  if (hasLocal && hasRemote) {
    return tryGit(root, ['merge-base', '--is-ancestor', local, remote]) !== undefined ? remote : local;
  }
  return hasLocal ? local : hasRemote ? remote : undefined;
}

/**
 * Every notepad, read straight from the ideas branch without checking it out
 * or merging it. Outside a git repository, a plain ideas/ folder is read instead.
 */
export function readNotepads(root: string): Notepad[] {
  const out: Notepad[] = [];
  const ref = isRepo(root) ? ideasRef(root) : undefined;
  if (ref) {
    const paths = git(root, ['ls-tree', '-r', '--name-only', ref, '--', `${IDEAS_DIR}/`]).split('\n').filter(Boolean);
    for (const path of paths) {
      const pad = parseNotepad(path, git(root, ['show', `${ref}:${path}`]));
      if (pad) out.push(pad);
    }
    return out;
  }
  const dir = join(root, IDEAS_DIR);
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir, { recursive: true }) as string[]) {
    const path = `${IDEAS_DIR}/${name.split('\\').join('/')}`;
    if (!path.endsWith('.md')) continue;
    const pad = parseNotepad(path, readFileSync(join(root, path), 'utf8'));
    if (pad) out.push(pad);
  }
  return out;
}

export interface ArgumentIdeas {
  /** The argument's own notepad and the notepads of its claims. */
  notepads: Notepad[];
  /** Notes tied to each claim, by mention or by living on that claim's notepad. */
  byClaim: Record<string, Idea[]>;
  /** Notes on the argument's notepad that mention no claim. */
  general: Idea[];
  /** The closing "Related ideas" lists: the notes most ready to become claims. */
  related: Idea[];
  /** Where to open the argument's notepad on GitHub, when the repository lives there. */
  url?: string;
}

export function githubUrl(root: string, path: string): string | undefined {
  const remote = tryGit(root, ['remote', 'get-url', 'origin']);
  const m = remote ? /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote) : null;
  return m ? `https://github.com/${m[1]}/${m[2]}/blob/${IDEAS_BRANCH}/${path}` : undefined;
}

/** The notes that bear on one argument: its notepad, plus the notepads of the claims it uses. */
export function ideasFor(root: string, name: string, arg: Argument): ArgumentIdeas {
  const notepads = readNotepads(root).filter((pad) => (pad.scope === 'argument' ? pad.name === name : arg.claims.has(pad.name)));
  const result: ArgumentIdeas = { notepads, byClaim: {}, general: [], related: [] };
  for (const pad of notepads) {
    for (const idea of pad.ideas) {
      const about = idea.mentions.filter((id) => arg.claims.has(id));
      for (const id of about) (result.byClaim[id] ??= []).push(idea);
      if (idea.related) result.related.push(idea);
      else if (about.length === 0) result.general.push(idea);
    }
  }
  const own = notepads.find((pad) => pad.scope === 'argument');
  const url = own ? githubUrl(root, own.path) : undefined;
  if (url) result.url = url;
  return result;
}

/* ---------- Writing ---------- */

/**
 * Commit files to the ideas branch without touching the working tree, so notes
 * can be added while another branch is checked out. Creates the branch if needed.
 */
export function commitToIdeas(root: string, files: { path: string; content: string }[], message: string): string {
  if (!isRepo(root)) throw new IdeasError('Notepads are saved on a git branch, and this folder is not a git repository.');
  if (tryGit(root, ['symbolic-ref', '--short', '-q', 'HEAD']) === IDEAS_BRANCH) {
    throw new IdeasError(`The ${IDEAS_BRANCH} branch is checked out here. Edit the notepad file directly and commit it.`);
  }
  const local = `refs/heads/${IDEAS_BRANCH}`;
  const parent = ideasRef(root);
  const scratch = mkdtempSync(join(tmpdir(), 'argmap-index-'));
  const env = { GIT_INDEX_FILE: join(scratch, 'index') };
  try {
    if (parent) git(root, ['read-tree', parent], { env });
    for (const file of files) {
      const blob = git(root, ['hash-object', '-w', '--stdin'], { input: file.content });
      git(root, ['update-index', '--add', '--cacheinfo', `100644,${blob},${file.path}`], { env });
    }
    const tree = git(root, ['write-tree'], { env });
    const sign = tryGit(root, ['config', '--bool', 'commit.gpgsign']) === 'true' ? ['-S'] : [];
    const commit = git(root, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), ...sign, '-m', message]);
    git(root, ['update-ref', local, commit]);
    return commit;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function currentText(root: string, path: string): string | undefined {
  const ref = ideasRef(root);
  return ref ? tryGit(root, ['show', `${ref}:${path}`]) : undefined;
}

export function createNotepad(root: string, scope: Scope, name: string, title: string, by: string): { path: string; commit: string } {
  const path = notepadPath(scope, name);
  if (currentText(root, path) !== undefined) throw new IdeasError(`There is already a notepad at ${path}.`);
  const content = [
    `# Notepad: ${title}`,
    '',
    'Loose thinking goes here. Nothing on this page affects the verdict, and nothing here has to be checked or pinned.',
    'Write anything under Notes. To tie a note to a claim, mention the claim as [[claim-id]].',
    'The page ends with related ideas: thoughts that could become new claims.',
    '',
    NOTES_HEADING,
    '',
    RELATED_HEADING,
    '',
  ].join('\n');
  return { path, commit: commitToIdeas(root, [{ path, content }], `Start a notepad for ${name}\n\nBy ${by}.`) };
}

/** Add a note. Related ideas go at the end of the page; other notes go at the end of the Notes section. */
export function addIdea(
  root: string,
  scope: Scope,
  name: string,
  text: string,
  options: { related?: boolean; by: string },
): { path: string; commit: string } {
  const path = notepadPath(scope, name);
  const before = currentText(root, path);
  if (before === undefined) {
    throw new IdeasError(`There is no notepad for ${scope} "${name}" yet. Notepads are created on request: create one first.`);
  }
  const body = text.replace(/\s+/g, ' ').trim();
  if (body === '') throw new IdeasError('The note is empty.');
  const line = `- ${body} (${options.by}, ${new Date().toISOString().slice(0, 10)})`;
  const lines = before.replace(/\s+$/, '').split('\n');
  const relatedAt = lines.findIndex((l) => l.trim().toLowerCase() === RELATED_HEADING.toLowerCase());
  if (options.related) {
    if (relatedAt === -1) lines.push('', RELATED_HEADING, '');
    else if (relatedAt === lines.length - 1) lines.push('');
    lines.push(line);
  } else if (relatedAt === -1) {
    lines.push(line);
  } else {
    let at = relatedAt;
    while (at > 0 && (lines[at - 1] as string).trim() === '') at--;
    const afterHeading = /^#+\s/.test(lines[at - 1] ?? '');
    lines.splice(at, relatedAt - at, ...(afterHeading ? ['', line, ''] : [line, '']));
  }
  const content = `${lines.join('\n')}\n`;
  return { path, commit: commitToIdeas(root, [{ path, content }], `Note on ${name}\n\nBy ${options.by}.`) };
}
