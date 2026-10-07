# V3 / PoW Diagnostic Site

Standalone diagnostic site for the vote2 reCAPTCHA v3 and signed proof-of-work flow.
It does not use the vote database or accept application writes.

## Runtime configuration

The service loads `/etc/yczx-musicvote2/recaptcha.env` first, reusing the site's
existing `RECAPTCHA_SITE_KEY`, `RECAPTCHA_SECRET`, and `RECAPTCHA_BASE` without
copying or printing their values. `/etc/yczx-v3-test.env` is loaded second for
test-specific overrides and must be restricted to root:

```ini
HOST=127.0.0.1
PORT=18790
RECAPTCHA_ALLOWED_HOSTS=v3.nas.popotree.top
RECAPTCHA_MIN_SCORE=0.5
POW_SECRET=<independent-random-secret>
POW_DIFFICULTY=3
```

The shared reCAPTCHA key must also permit `v3.nas.popotree.top` in its Google
reCAPTCHA domain settings. The server independently checks the returned hostname
against `RECAPTCHA_ALLOWED_HOSTS`. `POW_SECRET` is independent from the vote
service, at least 32 random bytes, and must not be committed. Without it, PoW is
shown as unconfigured.

## Service

The systemd unit is `yczx-v3-test.service`. It runs `server.mjs` on loopback
port 18790. Nginx terminates TLS on the existing wildcard certificate and
proxies only this hostname to that loopback service.

## Diagnostics

- Real runs call Google `siteverify`; the token is never returned to the browser
  after verification and is not logged or persisted.
- The shared Site Key is public by design and is injected into the page; the
  Secret Key is only loaded by the server process from the protected env file.
- The config API returns configuration status but never returns either key.
- The panel displays client token acquisition and PoW solve time, nonce attempts,
  server siteverify round-trip, score, hostname, action, verdict and reason.
- Failure-injection controls are clearly marked local simulations. They do not
  fabricate Google verdicts or scores.
- Results remain on the server and can also be exported as JSON or CSV.
- The endpoint is limited to 30 requests per client IP per minute.
- Each test is appended to `/var/lib/yczx-v3-test/runs.jsonl`; the page loads the
  latest 100 records from this shared server-side store. No token or raw IP is
  stored. Device label, user agent, platform, locale, timezone, screen size,
  difficulty and timing data are stored to compare devices and environments.
- The test page is intentionally public so it can be opened on different
  devices. Device metadata is visible to anyone who can access the test page;
  use a non-identifying label and do not enter personal information.
- PoW difficulty can be varied from 1 to 6 per test. The chosen level is included
  in the HMAC-signed challenge and is verified server-side.
