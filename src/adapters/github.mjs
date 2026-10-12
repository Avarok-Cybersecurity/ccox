// github.mjs — every GitHub REST call CCOX makes. Read-only except the one
// sticky PR comment. No call here checks out or executes pull-request code:
// changed files are listed through the files APIs, and file contents
// (definitions, or a file GitHub listed without a patch) are read as text at
// a fixed sha.

import { CcoxError } from '../core/errors.mjs';
import { FILES_PAGE_SIZE } from '../core/listing.mjs';
import { fetchWithTimeout, readBody, withRetry } from './http.mjs';

const ACCEPT_JSON = 'application/vnd.github+json';
const ACCEPT_RAW = 'application/vnd.github.raw';

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

export function createGitHub({ apiUrl, token, repository, timeoutMs, maxAttempts }, { fetchImpl, sleep, log }) {
  const base = apiUrl.replace(/\/+$/, '');
  const repoPath = `/repos/${repository.split('/').map(encodeURIComponent).join('/')}`;

  async function call(method, path, { accept = ACCEPT_JSON, body } = {}) {
    return withRetry(async () => {
      const headers = {
        Accept: accept,
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ccox',
      };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetchWithTimeout(
        fetchImpl,
        `${base}${path}`,
        { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
        { timeoutMs, kind: 'github' },
      );
      const text = await readBody(response, { what: `GitHub ${method} ${path}`, kind: 'github' });
      if (response.status < 200 || response.status >= 300) {
        throw new CcoxError('github', `GitHub ${method} ${path} answered HTTP ${response.status}: ${text.slice(0, 300)}`, {
          transient: response.status === 429 || response.status >= 500,
        });
      }
      return { text, link: response.headers.get('link') };
    }, { maxAttempts, sleep, log, label: 'github' });
  }

  async function json(method, path, opts) {
    const { text } = await call(method, path, opts);
    try {
      return JSON.parse(text);
    } catch {
      throw new CcoxError('github', `GitHub ${method} ${path} returned invalid JSON`);
    }
  }

  /**
   * Every page of a files listing, `maxFiles` at most: pages of
   * FILES_PAGE_SIZE until a short page. `pick` maps a page's JSON to its file
   * array. Returns the entries and the first page's JSON.
   */
  async function pagedFiles(path, maxFiles, pick) {
    const entries = [];
    let first = null;
    const sep = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= Math.ceil(maxFiles / FILES_PAGE_SIZE); page++) {
      const body = await json('GET', `${path}${sep}per_page=${FILES_PAGE_SIZE}&page=${page}`);
      first ??= body;
      const files = pick(body);
      if (!Array.isArray(files)) throw new CcoxError('github', `GitHub ${path} page ${page} carries no file list`);
      entries.push(...files);
      if (files.length < FILES_PAGE_SIZE) break;
    }
    return { entries, first };
  }

  /** A file's text at commit `ref`. */
  async function fileText(path, ref) {
    const { text } = await call('GET', `${repoPath}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`, { accept: ACCEPT_RAW });
    return text;
  }

  return {
    /** The PR's changed-file listing plus the head/base shas and file count it was taken at. */
    async pullFiles(pr, maxFiles) {
      const meta = await json('GET', `${repoPath}/pulls/${pr}`);
      const { entries } = await pagedFiles(`${repoPath}/pulls/${pr}/files`, maxFiles, (page) => page);
      const after = await json('GET', `${repoPath}/pulls/${pr}`);
      if (after.head?.sha !== meta.head?.sha) {
        throw new CcoxError('event', `PR #${pr} head moved while its files were listed; the newer run judges the newer head`);
      }
      return { entries, headSha: meta.head?.sha, baseSha: meta.base?.sha, changedFiles: meta.changed_files };
    },

    /** base...head (three-dot): its file listing (capped by GitHub) and the merge base it diffs from. */
    async compareFiles(baseSha, headSha) {
      const meta = await json('GET', `${repoPath}/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(headSha)}`);
      if (!Array.isArray(meta.files)) throw new CcoxError('github', `compare ${baseSha}...${headSha} lists no files`);
      return { entries: meta.files, mergeBase: meta.merge_base_commit?.sha ?? null };
    },

    /** One commit's file listing against its parent, with its parents and line stats. */
    async commitFiles(sha, maxFiles) {
      const { entries, first } = await pagedFiles(`${repoPath}/commits/${encodeURIComponent(sha)}`, maxFiles, (page) => page.files);
      const parents = Array.isArray(first?.parents) ? first.parents.map((p) => p.sha) : [];
      return { entries, parents, stats: first?.stats ?? null };
    },

    fileText,

    /** Every *.md directly inside `dir` at commit `ref`, as { fileName, text }. */
    async definitionsAt(dir, ref) {
      const listing = await json('GET', `${repoPath}/contents/${encodePath(dir)}?ref=${encodeURIComponent(ref)}`);
      if (!Array.isArray(listing)) {
        throw new CcoxError('definitions', `compliance-definitions-path ${dir} is not a directory at ${ref}`);
      }
      const files = listing.filter((e) => e.type === 'file' && e.name.endsWith('.md'));
      const out = [];
      for (const f of files) out.push({ fileName: f.name, text: await fileText(f.path, ref) });
      return out;
    },

    /** Create or update the one comment that starts with `marker`. */
    async upsertStickyComment(pr, marker, body) {
      let path = `${repoPath}/issues/${pr}/comments?per_page=100`;
      let existing = null;
      while (path && !existing) {
        const { text, link } = await call('GET', path);
        const page = JSON.parse(text);
        existing = page.find((c) => c.user?.type === 'Bot' && typeof c.body === 'string' && c.body.startsWith(marker)) ?? null;
        const next = /<([^>]+)>;\s*rel="next"/.exec(link ?? '');
        path = next ? next[1].slice(base.length) : null;
      }
      if (existing) {
        await json('PATCH', `${repoPath}/issues/comments/${existing.id}`, { body: { body } });
        return 'updated';
      }
      await json('POST', `${repoPath}/issues/${pr}/comments`, { body: { body } });
      return 'created';
    },
  };
}
