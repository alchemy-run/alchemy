# Queue producer buffering follow-up

Scope: producer-only and unavailable-consumer behavior in the local runtime, preserving the coordinator's Queue settings and consumer SQLite persistence work. No SDK patches, mocks, builds, or typechecks by this agent.

## Findings and fixes

- `RegistryProxy.ExternalQueueConsumer` previously drained and acknowledged requests while no consumer existed, permanently dropping successfully sent messages. It now returns HTTP 503 after draining; a producer-side SQLite-backed QueueBroker durably acknowledges the original binding call and retries registry forwarding. Network/unavailable-consumer failures retain messages without increasing handler attempts.
- Queue producer spool namespaces include worker identity and queue identity, separate from the queue's canonical consumer namespace. Two workerd processes never open the same spool SQLite database. Startup instantiates both consumer brokers and producer spools so saved pending messages resume without another send.
- When a producer-only worker becomes the consumer, its old producer spool remains attached as a drain service targeting the new consumer broker. This preserves the buffered messages through Consumer resource creation.
- Forwarding preserves IDs, creation timestamps, text/JSON/bytes/v8 payloads. A forwarded message's delay is zero because its original delay has elapsed already; downstream queue defaults do not add it again. Pending duplicate IDs are ignored to tolerate interrupted acknowledgments; delivery remains at least once.
- Dead-letter forwarding also gets a durable spool when its target is absent. Missing/non-successful DLQ delivery no longer deletes the source message.
- Queue delivery delay and retention settings travel through both Effect capability and async Worker binding descriptors (`localQueueSettings`), RuntimeBindings, and producer broker env. Metadata is stripped from real cloud script uploads. The broker evaluates retention against the original timestamp while offline.
- `RuntimeWorker.queueConsumers` documentation now describes persistent rather than in-memory storage. Public Queue.local documentation describes durable forwarding.

## Verification

Actual workerd fixture suites (no mocks):

`timeout 240 pnpm exec vitest run --project core src/core/test/bindings/Queue.test.ts src/core/test/bindings/QueueBuffering.test.ts src/core/test/bindings/QueueSettings.test.ts` from packages/cloudflare-runtime: **34 passed**, 17.73 seconds. Includes all four content types through offline producer forwarding, first delivery attempt remains 1, late consumer delivery, late DLQ delivery, original batching/retry/ack/structured clone/cross-instance tests, per-message zero delay, no double delay, offline retention expiry, pause/retention baseline.

Alchemy deployed fixture suite:

`timeout 240 pnpm test test/Cloudflare/Queues/DropProbe.local.test.ts --profile testing --timeout 120000`: **2 passed**, 16.1 seconds, log `packages/alchemy/.alchemy/log/test/2026-09-13T08-00-39-pid42737.log`. Both start/end stack.destroy. Producer-only send, real workerd restart, and subsequent separate consumer deployment; variant adds Consumer to the producer itself. Pending message delivered in both.

A combined rerun with the preexisting Queue.local suite also checks real remote-queue pull and deployed shim production; result recorded below once complete.

## Explicit limits

The runtime owns workerd lifetimes within a dev worker. If a producer process is entirely stopped while its consumer is absent, its accepted messages remain on disk and forwarding resumes when the same producer starts again. Merely starting a different consumer cannot autonomously drain a stopped producer's SQLite spool. An always-running account-level broker service would be needed to remove that process-lifetime limitation; reading active spools from another process would violate SQLite/workerd ownership. This implementation guarantees persistence across producer restarts, not a background delivery daemon after every dev process exits.

Delivery is at least once: termination after downstream acceptance but before spool acknowledgment may redeliver. Local queue TTL values below the cloud API minimum are used only in actual runtime fixtures to exercise expiration quickly.

Final lifetime fix: canonical broker and producer spool storage keys now include the local Queue's generated queueId (passed independently of registry queueName), preserving identity across settings/restarts while isolating delete/recreate generations. The local worker provider also resolves the dead-letter queue's lifetime ID. A real fixture destroys/recreates an explicit fixed queue name and fixed worker name, verifying both an offline producer spool and a paused consumer broker do not resurrect old messages. No unsafe deletion of open SQLite files.

Final local fixture rerun: **3 passed**, 32.3 seconds, log `packages/alchemy/.alchemy/log/test/2026-09-13T08-06-17-pid47226.log`. Combined broader run finished **6 tests successfully**, including the real remote queue/local consumer roundtrip (53.8 seconds), but hit the 240-second hard wall on the preexisting final remote-shim producer test. That final test is NOT counted as verified; log `packages/alchemy/.alchemy/log/test/2026-09-13T08-02-18-pid43518.log` ends after the preceding roundtrip cleanup because the unfinished test's output was buffered. Its remote producer path is unchanged in this subtask. All associated test processes stopped after the wall.

## Final isolated remote-shim verification

The previously unfinished producer test was rerun alone with no runner retries:

`timeout 240 pnpm test test/Cloudflare/Queues/Queue.local.test.ts -t 'Alchemy.remote\(\) queue in dev produces through the deployed shim' --profile testing --retry 0 --concurrency 1`

**1 passed**,19.9 seconds (20.5 seconds including collection). Summary: `.audit/cloudflare/queue-remote-shim-final.log`; full log: `packages/alchemy/.alchemy/log/test/2026-09-13T08-40-37-pid73175.log`.

The real deployment created a remote Queue and authenticated cloud shim, ran the local Worker, sent a text message and mixed text/JSON batch through the shim, and pulled the messages through the real Queue API. Stack destruction and an out-of-band typed QueueNotFound check completed. No source/test changes were needed; the earlier combined-run240s hang did not recur, so its exact cause remains unproven. This closes the previously unverified remote producer path without claiming that the original hang was diagnosed.
