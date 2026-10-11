// TEMPORARY recording relay for WP6: forwards POST /api/v1/chat/completions to
// OpenRouter and saves the exact response body bytes, the status and the
// request body (never any header) as <out>/<seq>.{status,response.json,request.json}.
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2];
mkdirSync(out, { recursive: true });
let seq = 0;
const FORWARD = ['authorization', 'content-type', 'http-referer', 'x-title'];
createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const n = String(++seq).padStart(2, '0');
    const body = Buffer.concat(chunks);
    writeFileSync(join(out, `${n}.request.json`), body);
    try {
      const headers = Object.fromEntries(FORWARD.filter((h) => req.headers[h]).map((h) => [h, req.headers[h]]));
      const r = await fetch(`https://openrouter.ai${req.url}`, { method: req.method, headers, body });
      const raw = Buffer.from(await r.arrayBuffer());
      writeFileSync(join(out, `${n}.status`), String(r.status));
      writeFileSync(join(out, `${n}.response.json`), raw);
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' });
      res.end(raw);
    } catch (e) {
      writeFileSync(join(out, `${n}.status`), `relay error: ${e.message}`);
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('relay error');
    }
  });
}).listen(8787, '127.0.0.1', () => console.log('relay listening on 127.0.0.1:8787'));
