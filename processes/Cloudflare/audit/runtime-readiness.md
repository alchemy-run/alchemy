# Deployed Worker readiness investigation

Date: 2026-09-13. Reproductions use real deployed fixture Workers with `--retry 0 --concurrency 1`; no mocked HTTP or cloud calls.

## Observations

- Broad Images batch failed because its old local fixture expected GIF output to be unsupported and parsed newly supported GIF bytes as JSON. This was a stale assertion, not readiness. Changed it to verify GIF content type, magic bytes, and decoded dimensions. Actual deployed local fixture passed in4s (`images-gif-regression.log`).
- D1 isolated full Effect/native binding fixture run passed2/2 (35s +22.6s). During the wait, independent Bun HTTP requests to the still-deployed worker returned404 with Cloudflare's HTML `Page not found` page; a cache-busting query returned the same404. The fixture subsequently served correctly without a deployment mutation. Evidence points to hostname propagation rather than D1 binding behavior. (`d1-readiness-repro.log`)
- DNS isolated deployed CRUD fixture passed in37.8s without automatic retries (`dns-readiness-repro.log`). Broad Access IdentityProvider failure also recorded404 with the same Cloudflare HTML page; Access was not independently rerun by this agent.
- AI Gateway readiness used uncapped exponential backoff,500ms for15 retries, allowing waits far beyond its180s test timeout. Changed to10 retries spaced5s and retained actual HTTP response diagnostics. Existing-deployment run passed; fresh deployment also passed in25.6s (40.6s with deploy/cleanup), with --retry0 (`ai-gateway-readiness-cold.log`).

## Changes

- D1 fixture: maximum10 readiness retries at5s; error message contains URL,status and response excerpt instead of an empty tagged-error message.
- DNS fixture: maximum10 readiness retries at5s; error contains actual status/URL/body;120s test timeout.
- AI Gateway fixture: maximum10 readiness retries at5s; error contains actual status/URL/body.
- Images local fixture now tests supported GIF encoding/decoding;120s test timeouts.
- Temporary observation/probe code was removed. No production Worker provider changes were made for readiness. Local Vite config separately gained the already-supported namespace field to complete DispatchNamespace typing.

The investigation does not establish that every prior parallel-batch404 had the same cause. It establishes actual transient Cloudflare placeholder responses during successful deployed D1/DNS fixtures and corrects concrete test failures/unbounded waits without gating them or treating non-200 responses as success.

## Final verification

- Updated D1/DNS readiness fixtures:3 passed, no automatic retries; D1 Effect20.7s, D1 native540ms, DNS41.2s. Full deploy/test/cleanup79.8s (`d1-dns-readiness-bounded.log`).
- Fresh AI Gateway deployed binding:1 passed, no automatic retries (`ai-gateway-readiness-cold.log`).
- Updated local Images GIF fixture:1 passed, no automatic retries (`images-gif-regression.log`).
