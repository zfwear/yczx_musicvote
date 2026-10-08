import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const secretPath = '/etc/yczx-musicvote/webhook-secret';
const endpoint = '/github/yczx-musicvote';
const maxBodyBytes = 1024 * 1024;
const secret = (await readFile(secretPath, 'utf8')).trim();
if (secret.length < 32) throw new Error('Webhook secret is too short');

const server = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== endpoint) {
    res.writeHead(404).end();
    return;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      res.writeHead(413).end();
      req.destroy();
      return;
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  const supplied = req.headers['x-hub-signature-256'] || '';
  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  if (suppliedBuffer.length !== expectedBuffer.length || !timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    res.writeHead(401).end();
    return;
  }

  if (req.headers['x-github-event'] !== 'push') {
    res.writeHead(202).end('ignored');
    return;
  }

  let payload;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    res.writeHead(400).end('invalid payload');
    return;
  }
  if (payload.repository?.full_name !== 'zfwear/yczx_musicvote' || payload.ref !== 'refs/heads/main') {
    res.writeHead(202).end('ignored');
    return;
  }

  const child = spawn('systemctl', ['start', 'yczx-musicvote-sync.service'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  res.writeHead(202).end('accepted');
});

server.listen(18791, '127.0.0.1');
