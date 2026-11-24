// Minimal static file server for local development and the demo capture.
// Node stdlib only. Usage: node scripts/serve.mjs [port]

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.argv[2] || process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv',
};

export function createStaticServer(listenPort = port) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let path = decodeURIComponent(url.pathname);
      if (path.endsWith('/')) path += 'index.html';
      const file = normalize(join(root, path));
      if (!file.startsWith(normalize(root))) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(listenPort, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, root });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port: p } = await createStaticServer(port);
  console.log(`PadCraft on http://127.0.0.1:${p}/`);
}
