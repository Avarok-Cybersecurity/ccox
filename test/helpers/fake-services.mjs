// A real local HTTP server standing in for the GitHub REST API and a
// chat-completions endpoint, so the end-to-end suite runs src/main.mjs
// unmodified (real fetch, real adapters) without network access. The GitHub
// routes follow the documented behaviour CCOX depends on: files listings
// paged by per_page/page (max 100), compare listing at most 300 files on its
// first page only, and raw file contents per ref.

import { createServer } from 'node:http';

const REPO = '/api/repos/o/r';
const COMPARE_CAP = 300;

/** GitHub file entries for a unified diff (test fixture plumbing; not CCOX's parser). */
export function entriesFromDiff(diff) {
  return diff.split(/^(?=diff --git )/m).filter(Boolean).map((section) => {
    const lines = section.replace(/\n$/, '').split('\n');
    const plus = lines.find((l) => l.startsWith('+++ '));
    const minus = lines.find((l) => l.startsWith('--- '));
    const deleted = lines.some((l) => l.startsWith('deleted file mode '));
    const filename = deleted ? minus.slice(6) : plus.slice(6);
    const hunkStart = lines.findIndex((l) => l.startsWith('@@'));
    const body = hunkStart === -1 ? [] : lines.slice(hunkStart);
    const additions = body.filter((l) => l.startsWith('+')).length;
    const deletions = body.filter((l) => l.startsWith('-')).length;
    let status = 'modified';
    if (lines.some((l) => l.startsWith('new file mode '))) status = 'added';
    if (deleted) status = 'removed';
    return { filename, status, additions, deletions, changes: additions + deletions, patch: body.join('\n') };
  });
}

/** A one-line added text file entry, with its patch. */
export function addedEntry(filename) {
  return { filename, status: 'added', additions: 1, deletions: 0, changes: 1, patch: '@@ -0,0 +1 @@\n+x' };
}

const statsOf = (entries) => ({
  additions: entries.reduce((n, e) => n + e.additions, 0),
  deletions: entries.reduce((n, e) => n + e.deletions, 0),
});

/**
 * @param {object} o
 * @param {object[]} o.files            GitHub file entries of the PR / comparison
 * @param {number} o.changedFiles       the PR's `changed_files`
 * @param {string} o.baseSha / o.headSha
 * @param {string} [o.mergeBase]        compare's merge_base_commit (default baseSha)
 * @param {string[]} [o.commitParents]  parents of the head commit (default [baseSha])
 * @param {object} [o.commitStats]      head commit stats (default: summed from files)
 * @param {Record<string, Record<string, string>>} [o.blobs]  sha -> path -> raw file text
 * @param {Record<string, Record<string, Array<{name: string, text: string}>>>} o.trees
 *        sha -> directory -> markdown files available at that sha
 * @param {Array<{status: number, body: string}>} o.completions  scripted model answers
 */
export async function startFakeServices({
  files, changedFiles, baseSha, headSha, mergeBase = baseSha, commitParents = [baseSha], commitStats = statsOf(files),
  blobs = {}, trees, completions,
}) {
  const requests = [];
  let completionIndex = 0;

  const page = (url, list) => {
    const perPage = Math.min(Number(url.searchParams.get('per_page') ?? 30), 100);
    const n = Number(url.searchParams.get('page') ?? 1);
    return list.slice((n - 1) * perPage, n * perPage);
  };

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const record = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: raw };
      requests.push(record);
      const send = (status, body, type = 'application/json') => {
        res.writeHead(status, { 'content-type': type });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };

      if (req.method === 'POST' && url.pathname === '/llm/chat/completions') {
        const answer = completions[Math.min(completionIndex, completions.length - 1)];
        completionIndex += 1;
        return send(answer.status, answer.body);
      }
      if (req.method === 'GET' && url.pathname === `${REPO}/pulls/7`) {
        return send(200, { number: 7, changed_files: changedFiles, base: { sha: baseSha }, head: { sha: headSha } });
      }
      if (req.method === 'GET' && url.pathname === `${REPO}/pulls/7/files`) return send(200, page(url, files));
      if (req.method === 'GET' && url.pathname === `${REPO}/compare/${baseSha}...${headSha}`) {
        const listed = url.searchParams.has('page') && url.searchParams.get('page') !== '1' ? [] : files.slice(0, COMPARE_CAP);
        return send(200, { files: listed, merge_base_commit: { sha: mergeBase }, total_commits: 1 });
      }
      if (req.method === 'GET' && url.pathname === `${REPO}/commits/${headSha}`) {
        return send(200, { sha: headSha, parents: commitParents.map((sha) => ({ sha })), stats: commitStats, files: page(url, files) });
      }
      const contents = `${REPO}/contents/`;
      if (req.method === 'GET' && url.pathname.startsWith(contents)) {
        const path = decodeURIComponent(url.pathname.slice(contents.length));
        const ref = url.searchParams.get('ref');
        if (typeof blobs[ref]?.[path] === 'string') return send(200, blobs[ref][path], 'text/plain');
        const tree = trees[ref] ?? {};
        if (tree[path]) {
          return send(200, tree[path].map((f) => ({ type: 'file', name: f.name, path: `${path}/${f.name}` })));
        }
        const slash = path.lastIndexOf('/');
        const file = (tree[path.slice(0, slash)] ?? []).find((f) => f.name === path.slice(slash + 1));
        if (file) return send(200, file.text, 'text/plain');
        return send(404, { message: 'Not Found' });
      }
      if (url.pathname === `${REPO}/issues/7/comments`) {
        if (req.method === 'GET') return send(200, []);
        if (req.method === 'POST') return send(201, { id: 1 });
      }
      return send(404, { message: `no route for ${req.method} ${url.pathname}` });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
