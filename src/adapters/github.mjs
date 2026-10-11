// github.mjs — every GitHub REST call CCOX makes. Read-only except the one
// sticky PR comment. No call here checks out or executes pull-request code:
// the diff is fetched as text, definitions as file contents at a fixed sha.

import { CcoxError } from '../core/errors.mjs';
import { fetchWithTimeout, readBody, withRetry } from './http.mjs';

const ACCEPT_JSON = 'application/vnd.github+json';
const ACCEPT_DIFF = 'application/vnd.github.diff';
const ACCEPT_RAW = 'application/vnd.github.raw';
// The compare API lists at most 300 files; at that size completeness of the
// diff cannot be verified, so CCOX refuses rather than judge a partial diff.
const COMPARE_FILE_CAP = 300;

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
      if (response.status === 406 || (response.status === 422 && /too_large|too large|exceeded/i.test(text))) {
        throw new CcoxError('diff_too_large', `GitHub refused the diff for ${path} (HTTP ${response.status}): ${text.slice(0, 300)}`);
      }
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

  return {
    /** The PR's diff plus the head/base shas and file count it was taken at. */
    async pullDiff(pr) {
      const meta = await json('GET', `${repoPath}/pulls/${pr}`);
      const { text } = await call('GET', `${repoPath}/pulls/${pr}`, { accept: ACCEPT_DIFF });
      const after = await json('GET', `${repoPath}/pulls/${pr}`);
      if (after.head?.sha !== meta.head?.sha) {
        throw new CcoxError('event', `PR #${pr} head moved while its diff was fetched; the newer run judges the newer head`);
      }
      return { diff: text, headSha: meta.head?.sha, baseSha: meta.base?.sha, expectedFiles: meta.changed_files };
    },

    /** The base...head diff (merge-group entries) and its listed file count. */
    async compareDiff(baseSha, headSha) {
      const path = `${repoPath}/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(headSha)}`;
      const meta = await json('GET', path);
      const listed = Array.isArray(meta.files) ? meta.files.length : -1;
      if (listed < 0) throw new CcoxError('github', `compare ${baseSha}...${headSha} lists no files`);
      if (listed >= COMPARE_FILE_CAP) {
        throw new CcoxError('diff_too_large', `compare lists ${listed} files (cap ${COMPARE_FILE_CAP}); completeness cannot be verified`);
      }
      const { text } = await call('GET', path, { accept: ACCEPT_DIFF });
      return { diff: text, expectedFiles: listed };
    },

    /** Every *.md directly inside `dir` at commit `ref`, as { fileName, text }. */
    async definitionsAt(dir, ref) {
      const listing = await json('GET', `${repoPath}/contents/${encodePath(dir)}?ref=${encodeURIComponent(ref)}`);
      if (!Array.isArray(listing)) {
        throw new CcoxError('definitions', `compliance-definitions-path ${dir} is not a directory at ${ref}`);
      }
      const files = listing.filter((e) => e.type === 'file' && e.name.endsWith('.md'));
      const out = [];
      for (const f of files) {
        const { text } = await call('GET', `${repoPath}/contents/${encodePath(f.path)}?ref=${encodeURIComponent(ref)}`, { accept: ACCEPT_RAW });
        out.push({ fileName: f.name, text });
      }
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
