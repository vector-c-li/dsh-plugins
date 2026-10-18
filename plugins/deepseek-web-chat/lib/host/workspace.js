/**
 * Workspace-scoped file access for the side panel.
 *
 * The panel may only read inside a registered workspace root: every request is
 * resolved against the root, canonicalized with `realpath`, and rejected when
 * the canonical target escapes the canonical root. Reads are byte-capped so a
 * stray binary or a huge log cannot stall the request.
 */
import { readdir, readFile, stat, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const SKIP_DIRECTORIES = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.turbo']);

/** Resolve the root a request is relative to. */
export async function resolveWorkspaceRoot(requested, config) {
  const candidate = requested && typeof requested === 'string' ? requested : config.workspaceRoot;
  if (!candidate) throw new Error('No workspace root is registered for this profile');
  const absolute = path.resolve(candidate);
  const canonical = await realpath(absolute);
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new Error(`${canonical} is not a directory`);
  return canonical;
}

/** Canonicalize a root without throwing for a missing directory. */
export function rootOrFallback(requested, config) {
  const candidate = requested && typeof requested === 'string' ? requested : config.workspaceRoot;
  if (!candidate) return process.cwd();
  const absolute = path.resolve(candidate);
  return existsSync(absolute) ? absolute : process.cwd();
}

/** Resolve one relative path inside the root, refusing escapes. */
async function resolveInside(root, relative) {
  const rootCanonical = await realpath(root).catch(() => path.resolve(root));
  const target = path.resolve(rootCanonical, relative ?? '');
  const canonical = await realpath(target).catch(() => target);
  const withSeparator = rootCanonical.endsWith(path.sep) ? rootCanonical : rootCanonical + path.sep;
  if (canonical !== rootCanonical && !canonical.startsWith(withSeparator)) {
    throw new Error('Path escapes the workspace root');
  }
  return { root: rootCanonical, target: canonical };
}

/** List one directory of the workspace, directories first. */
export async function listWorkspaceDirectory({ path: relative, root, config }) {
  const resolvedRoot = await resolveWorkspaceRoot(root, config);
  const { target } = await resolveInside(resolvedRoot, relative ?? '');
  const info = await stat(target);
  if (!info.isDirectory()) throw new Error('Not a directory');
  const names = await readdir(target, { withFileTypes: true });
  const entries = [];
  for (const dirent of names) {
    if (dirent.name.startsWith('.') && dirent.name !== '.env.example') continue;
    const isDirectory = dirent.isDirectory();
    if (isDirectory && SKIP_DIRECTORIES.has(dirent.name)) continue;
    const entryPath = relative ? `${relative}/${dirent.name}` : dirent.name;
    let size = 0;
    try {
      size = isDirectory ? 0 : (await stat(path.join(target, dirent.name))).size;
    } catch {
      continue;
    }
    entries.push({ name: dirent.name, path: entryPath, kind: isDirectory ? 'directory' : 'file', size });
    if (entries.length >= 400) break;
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
  return {
    root: resolvedRoot,
    path: relative ?? '',
    entries,
  };
}

/** Read one workspace file as UTF-8 text, capped and binary-guarded. */
export async function readWorkspaceFile({ path: relative, root, config, maxBytes }) {
  const resolvedRoot = await resolveWorkspaceRoot(root, config);
  const { target } = await resolveInside(resolvedRoot, relative);
  const info = await stat(target);
  if (!info.isFile()) throw new Error('Not a file');
  const budget = Math.max(0, Math.min(maxBytes ?? config.maxFileBytes, config.maxFileBytes));
  const handle = await readFile(target);
  const truncated = handle.byteLength > budget;
  const slice = truncated ? handle.subarray(0, budget) : handle;
  if (slice.includes(0)) throw new Error('Binary file, skipped');
  const text = slice.toString('utf8');
  const relativePath = path.relative(resolvedRoot, target).split(path.sep).join('/');
  return {
    path: relativePath,
    bytes: slice.byteLength,
    truncated,
    text: truncated ? `${text}\n…（已截断，原文件 ${handle.byteLength} 字节）` : text,
    size: handle.byteLength,
  };
}
