import { createServer } from 'node:http';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 18790);
const host = process.env.HOST || '127.0.0.1';
const siteKey = process.env.RECAPTCHA_SITE_KEY || '';
const secret = process.env.RECAPTCHA_SECRET || '';
const allowedHosts = (process.env.RECAPTCHA_ALLOWED_HOSTS || 'v3.nas.popotree.top')
  .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
const recaptchaBase = (process.env.RECAPTCHA_BASE || 'https://www.recaptcha.net').replace(/\/+$/, '');
const configuredMinScore = Number(process.env.RECAPTCHA_MIN_SCORE || 0.5);
const minScore = Number.isFinite(configuredMinScore) && configuredMinScore >= 0 && configuredMinScore <= 1 ? configuredMinScore : 0.5;
const powDifficulty = clampInt(process.env.POW_DIFFICULTY, 3, 1, 6);
const powTtl = 300;
const powSecret = process.env.POW_SECRET || '';
const recordsPath = process.env.RECORDS_PATH || '/var/lib/yczx-v3-test/runs.jsonl';
const maxBodyBytes = 32 * 1024;
const rate = new Map();

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > maxBodyBytes) throw Object.assign(new Error('Request body too large'), { status: 413 });
  }
  try { return JSON.parse(raw || '{}'); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function rateLimited(ip) {
  const now = Date.now();
  if (rate.size > 5000) {
    for (const [key, value] of rate) if (now - value.start > 60_000) rate.delete(key);
  }
  const entry = rate.get(ip);
  if (!entry || now - entry.start > 60_000) {
    rate.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > 30;
}

function sign(message) {
  return createHmac('sha256', powSecret).update(message).digest('hex');
}

function issueChallenge(action, difficulty) {
  const exp = Math.floor(Date.now() / 1000) + powTtl;
  const challenge = randomBytes(16).toString('base64url');
  const signed = `pow|${action}|${difficulty}|${exp}|${challenge}`;
  const sig = sign(signed);
  return { challenge: ['v1', action, difficulty, exp, challenge, sig].join('.'), difficulty, expiresIn: powTtl };
}

function leadingZeroNibbles(hex) {
  let zeros = 0;
  for (const char of hex) {
    const nibble = Number.parseInt(char, 16);
    if (nibble !== 0) break;
    zeros++;
  }
  return zeros;
}

function safeErrorCodes(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string' && /^[a-z_]+$/.test(item));
}

function cleanLabel(value, maxLength = 80) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength) : '';
}

async function storeRun(record) {
  await mkdir(dirname(recordsPath), { recursive: true, mode: 0o700 });
  await appendFile(recordsPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

async function listRuns(url) {
  let text = '';
  try { text = await readFile(recordsPath, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const all = text.split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const limit = clampInt(url.searchParams.get('limit'), 100, 1, 500);
  return all.slice(-limit).reverse();
}

function verifyPow(proof, expectedAction, requestedDifficulty) {
  const reject = (reason) => ({ ok: false, reason });
  if (!powSecret) return { ok: true, skipped: true, reason: 'pow_not_configured' };
  if (!proof || typeof proof.challenge !== 'string' || typeof proof.nonce !== 'string') return reject('proof_missing');
  if (proof.challenge.length > 400 || proof.nonce.length > 128) return reject('proof_too_long');
  const parts = proof.challenge.split('.');
  if (parts.length !== 6) return reject('challenge_format');
  const [version, action, difficultyText, expText, challenge, sig] = parts;
  if (version !== 'v1') return reject('challenge_version');
  if (action !== expectedAction) return reject('action_mismatch');
  const difficulty = clampInt(requestedDifficulty, powDifficulty, 1, 6);
  if (!/^\d+$/.test(difficultyText) || Number(difficultyText) !== difficulty) return reject('difficulty_mismatch');
  if (!/^\d+$/.test(expText) || Math.floor(Date.now() / 1000) > Number(expText)) return reject('challenge_expired');
  const expectedSig = sign(`pow|${action}|${difficultyText}|${expText}|${challenge}`);
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expectedSig, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return reject('signature_invalid');
  const hash = createHash('sha256').update(`${challenge}:${proof.nonce}`).digest('hex');
  if (leadingZeroNibbles(hash) < difficulty) return reject('insufficient_work');
  return { ok: true, action, difficulty, hashPrefix: hash.slice(0, 16) };
}

async function verifyRecaptcha(token, { remoteIp, expectedAction }) {
  const started = performance.now();
  const result = { ok: false, configured: Boolean(siteKey && secret), serviceMs: null, reason: null };
  if (!siteKey || !secret) return { ...result, ok: false, reason: 'recaptcha_not_configured', error: '服务端尚未配置 reCAPTCHA Site Key/Secret Key' };
  if (typeof token !== 'string' || !token.trim()) return { ...result, reason: 'token_missing', error: '没有收到 reCAPTCHA token' };
  try {
    const body = new URLSearchParams({ secret, response: token.trim() });
    if (remoteIp) body.set('remoteip', remoteIp);
    const response = await fetch(`${recaptchaBase}/recaptcha/api/siteverify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    result.serviceMs = Number((performance.now() - started).toFixed(2));
    const data = await response.json();
    result.httpStatus = response.status;
    result.success = data.success === true;
    result.score = typeof data.score === 'number' ? data.score : null;
    result.hostname = typeof data.hostname === 'string' ? data.hostname : null;
    result.action = typeof data.action === 'string' ? data.action : null;
    result.challengeTs = data.challenge_ts || null;
    result.errorCodes = safeErrorCodes(data['error-codes']);
    if (!response.ok) return { ...result, ok: false, reason: 'siteverify_http_error', error: `siteverify HTTP ${response.status}` };
    if (data.success !== true) return { ...result, ok: false, reason: 'google_rejected', error: 'Google 未接受此 token' };
    if (result.score != null && result.score < minScore) return { ...result, ok: false, reason: 'low_score', error: `分数低于阈值 ${minScore}` };
    const hostOk = result.hostname && allowedHosts.some((allowed) => result.hostname.toLowerCase() === allowed || result.hostname.toLowerCase().endsWith(`.${allowed}`));
    if (!hostOk) return { ...result, ok: false, reason: 'hostname_mismatch', error: 'token hostname 不在服务端允许列表中' };
    if (expectedAction && result.action !== expectedAction) return { ...result, ok: false, reason: 'action_mismatch', error: 'token action 与本次测试 action 不匹配' };
    return { ...result, ok: true, reason: 'verified' };
  } catch (error) {
    result.serviceMs = Number((performance.now() - started).toFixed(2));
    return { ...result, reason: error.name === 'TimeoutError' ? 'siteverify_timeout' : 'siteverify_unavailable', error: error.name === 'TimeoutError' ? 'siteverify 请求超时' : '无法连接 siteverify' };
  }
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/') {
    try {
      const html = await readFile(join(root, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.recaptcha.net https://www.gstatic.cn; style-src 'self' 'unsafe-inline'; connect-src 'self' https://www.recaptcha.net https://www.gstatic.cn; img-src 'self' data: https://www.recaptcha.net; frame-src https://www.recaptcha.net; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" });
      return res.end(html.toString()
        .replaceAll('__RECAPTCHA_SITE_KEY__', siteKey)
        .replaceAll('__RECAPTCHA_BASE__', recaptchaBase));
    } catch { return sendJson(res, 500, { ok: false, error: 'Test page not found' }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/config') {
    return sendJson(res, 200, {
      recaptcha: { configured: Boolean(siteKey && secret), base: recaptchaBase, allowedHosts, minScore },
      pow: { configured: Boolean(powSecret), enabled: Boolean(powSecret), difficulty: powDifficulty, ttl: powTtl },
      serverTime: new Date().toISOString(),
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/runs') {
    try { return sendJson(res, 200, { ok: true, runs: await listRuns(url) }); }
    catch { return sendJson(res, 500, { ok: false, error: '无法读取服务器测试记录' }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/pow/challenge') {
    if (rateLimited(clientIp(req))) return sendJson(res, 429, { ok: false, error: 'Too many test requests (30/min)' });
    const action = ['vote', 'upvote', 'diagnostic'].includes(url.searchParams.get('action')) ? url.searchParams.get('action') : 'diagnostic';
    const difficulty = clampInt(url.searchParams.get('difficulty'), powDifficulty, 1, 6);
    if (!powSecret) return sendJson(res, 200, { ok: true, enabled: false, action, reason: 'pow_not_configured' });
    return sendJson(res, 200, { ok: true, enabled: true, action, ...issueChallenge(action, difficulty) });
  }
  if (req.method === 'POST' && url.pathname === '/api/test') {
    if (rateLimited(clientIp(req))) return sendJson(res, 429, { ok: false, error: 'Too many test requests (30/min)' });
    try {
      const body = await readJson(req);
      const expectedAction = typeof body.action === 'string' ? body.action.slice(0, 80) : 'diagnostic';
      const recaptchaPromise = verifyRecaptcha(body.token, { remoteIp: clientIp(req), expectedAction });
      const powStarted = performance.now();
      const difficulty = clampInt(body.difficulty, powDifficulty, 1, 6);
      const pow = body.checkPow === false
        ? { ok: true, skipped: true, reason: 'not_requested' }
        : verifyPow(body.proof, expectedAction, difficulty);
      const powMs = Number((performance.now() - powStarted).toFixed(3));
      const recaptcha = await recaptchaPromise;
      const ok = recaptcha.ok && pow.ok;
      const result = {
        ok,
        verdict: ok ? 'pass' : 'reject',
        recaptcha,
        pow: { ...pow, verifyMs: powMs, enabled: Boolean(powSecret) },
        totalMs: Number((recaptcha.serviceMs == null ? powMs : recaptcha.serviceMs + powMs).toFixed(2)),
        serverTime: new Date().toISOString(),
      };
      const record = {
        id: randomBytes(12).toString('hex'),
        createdAt: result.serverTime,
        label: cleanLabel(body.label, 80),
        client: {
          userAgent: cleanLabel(req.headers['user-agent'], 240),
          platform: cleanLabel(body.client?.platform, 80),
          language: cleanLabel(body.client?.language, 35),
          timezone: cleanLabel(body.client?.timezone, 80),
          screen: cleanLabel(body.client?.screen, 30),
          deviceId: cleanLabel(body.client?.deviceId, 64),
        },
        action: expectedAction,
        requestedDifficulty: difficulty,
        checkPow: body.checkPow !== false,
        tokenMs: Number.isFinite(body.client?.tokenMs) ? Math.max(0, Math.min(body.client.tokenMs, 600_000)) : null,
        powClientMs: Number.isFinite(body.client?.powMs) ? Math.max(0, Math.min(body.client.powMs, 600_000)) : null,
        powAttempts: Number.isInteger(body.client?.powAttempts) ? Math.max(0, Math.min(body.client.powAttempts, 100_000_000)) : null,
        clientRequestMs: Number.isFinite(body.client?.requestMs) ? Math.max(0, Math.min(body.client.requestMs, 600_000)) : null,
        simulated: body.simulated === true,
        ...result,
      };
      try { await storeRun(record); }
      catch { return sendJson(res, 507, { ok: false, error: '验证已完成，但服务器无法保存本轮记录' }); }
      return sendJson(res, 200, { ...result, recordId: record.id });
    } catch (error) {
      return sendJson(res, error.status || 400, { ok: false, error: error.message });
    }
  }
  if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
  return sendJson(res, 404, { ok: false, error: 'Not found' });
}

const server = createServer((req, res) => {
  handle(req, res).catch(() => sendJson(res, 500, { ok: false, error: 'Internal server error' }));
});
server.listen(port, host, () => console.log(`v3 test site listening on ${host}:${port}`));
