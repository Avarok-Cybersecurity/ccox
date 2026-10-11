// A real local HTTP server standing in for the GitHub REST API and a
// chat-completions endpoint, so the end-to-end suite runs src/main.mjs
// unmodified (real fetch, real adapters) without network access.

import { createServer } from 'node:http';

const REPO = '/api/repos/o/r';

/**
 * @param {object} o
 * @param {string} o.diff               unified diff served for the PR / compare
 * @param {number} o.changedFiles       file count GitHub claims for the diff
 * @param {string} o.baseSha / o.headSha
 * @param {Record<string, Record<string, Array<{name: string, text: string}>>>} o.trees
 *        sha -> directory -> markdown files available at that sha
 * @param {Array<{status: number, body: string}>} o.completions  scripted model answers
 */
export async function startFakeServices({ diff, changedFiles, baseSha, headSha, trees, completions }) {
  const requests = [];
  let completionIndex = 0;

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
      const wantsDiff = (req.headers.accept ?? '').includes('diff');

      if (req.method === 'POST' && url.pathname === '/llm/chat/completions') {
        const answer = completions[Math.min(completionIndex, completions.length - 1)];
        completionIndex += 1;
        return send(answer.status, answer.body);
      }
      if (req.method === 'GET' && url.pathname === `${REPO}/pulls/7`) {
        if (wantsDiff) return send(200, diff, 'text/plain');
        return send(200, { number: 7, changed_files: changedFiles, base: { sha: baseSha }, head: { sha: headSha } });
      }
      if (req.method === 'GET' && url.pathname === `${REPO}/compare/${baseSha}...${headSha}`) {
        if (wantsDiff) return send(200, diff, 'text/plain');
        return send(200, { files: Array.from({ length: changedFiles }, (_, i) => ({ filename: `f${i}` })) });
      }
      const contents = `${REPO}/contents/`;
      if (req.method === 'GET' && url.pathname.startsWith(contents)) {
        const path = decodeURIComponent(url.pathname.slice(contents.length));
        const tree = trees[url.searchParams.get('ref')] ?? {};
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
