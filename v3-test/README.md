# V3 / PoW Diagnostic Site

Standalone diagnostic site for the vote2 reCAPTCHA v3 and signed proof-of-work flow.
It does not use the vote database or accept application writes.

## Runtime configuration

Create `/etc/yczx-v3-test.env` outside the repository and restrict it to root:

```ini
HOST=127.0.0.1
PORT=18790
RECAPTCHA_SITE_KEY=<diagnostic-site-key>
RECAPTCHA_SECRET=<diagnostic-secret-key>
RECAPTCHA_ALLOWED_HOSTS=v3.nas.popotree.top
RECAPTCHA_BASE=https://www.recaptcha.net
RECAPTCHA_MIN_SCORE=0.5
POW_SECRET=<independent-random-secret>
POW_DIFFICULTY=3
```

Register `v3.nas.popotree.top` as a separate reCAPTCHA v3 site. Do not reuse the
production secret. `POW_SECRET` should be independently generated, at least 32
random bytes, and must not be committed. Without it, PoW is shown as unconfigured.

## Service

The systemd unit is `yczx-v3-test.service`. It runs `server.mjs` on loopback
port 18790. Nginx terminates TLS on the existing wildcard certificate and
proxies only this hostname to that loopback service.

## Diagnostics

- Real runs call Google `siteverify`; the token is never returned to the browser
  after verification and is not logged or persisted.
- The panel displays client token acquisition and PoW solve time, nonce attempts,
  server siteverify round-trip, score, hostname, action, verdict and reason.
- Failure-injection controls are clearly marked local simulations. They do not
  fabricate Google verdicts or scores.
- Results remain in browser memory unless explicitly exported as JSON or CSV.
- The endpoint is limited to 30 requests per client IP per minute.
