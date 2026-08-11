import * as AWS from "alchemy/AWS";
import * as Binding from "alchemy/Binding";
import { viewer } from "alchemy/Dashboard/Viewer";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * The read-only dashboard viewer API over the S3 state store, as a
 * Lambda. Unlike the Cloudflare state store (an HTTP API worker), the
 * AWS store has no server — this function IS the reader: its execution
 * role gets `s3:GetObject`/`s3:ListBucket` on the state bucket plus
 * `kms:Decrypt` for the store's envelope-encrypted secrets, so no
 * long-lived credentials exist anywhere.
 *
 * Reads the same env at deploy time (to grant + forward) and at runtime
 * (to configure the store): `ALCHEMY_STATE_BUCKET` / `ALCHEMY_STATE_PREFIX`
 * default to the account-regional `alchemy-state-{account}-{region}-an`
 * bucket `AWS.state()` uses.
 */
const readEnv = (name: string) =>
  Effect.sync(() => process.env[name] || undefined);

export default class ViewerFunction extends AWS.Lambda.Function<ViewerFunction>()(
  "ViewerFunction",
  {
    main: import.meta.url,
    url: true,
    memorySize: 512,
  },
  Effect.gen(function* () {
    const bucketName = yield* readEnv("ALCHEMY_STATE_BUCKET");
    const prefix = yield* readEnv("ALCHEMY_STATE_PREFIX");

    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const host = yield* Binding.Host;
      if (AWS.Lambda.isBindingHost(host)) {
        // Without an explicit bucket the store derives the account-regional
        // default; the wildcard covers it without resolving account/region
        // at plan time.
        const bucketArn = bucketName
          ? `arn:aws:s3:::${bucketName}`
          : "arn:aws:s3:::alchemy-state-*";
        const stack = yield* readEnv("ALCHEMY_VIEWER_STACK");
        const stage = yield* readEnv("ALCHEMY_VIEWER_STAGE");
        yield* host.bind`Allow(${host}, DashboardViewerStateRead)`({
          env: {
            ...(bucketName ? { ALCHEMY_STATE_BUCKET: bucketName } : {}),
            ...(prefix ? { ALCHEMY_STATE_PREFIX: prefix } : {}),
            ...(stack ? { ALCHEMY_VIEWER_STACK: stack } : {}),
            ...(stage ? { ALCHEMY_VIEWER_STAGE: stage } : {}),
          },
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["s3:ListBucket"],
              Resource: [bucketArn],
            },
            {
              Effect: "Allow",
              Action: ["s3:GetObject"],
              Resource: [`${bucketArn}/*`],
            },
            // The store's secrets are wrapped by the auto-managed
            // `alias/alchemy-state` KMS key. Decrypt cannot be scoped by
            // alias (the ciphertext names the key, the request never
            // does); pin the key ARN here if your account policy
            // requires it.
            {
              Effect: "Allow",
              Action: ["kms:Decrypt"],
              Resource: ["*"],
            },
          ],
        });
      }
    }

    const state = yield* AWS.makeS3State({
      ...(bucketName !== undefined ? { bucketName } : {}),
      ...(prefix !== undefined ? { prefix } : {}),
    }).pipe(Effect.provide(FetchHttpClient.layer));

    const handle = viewer({
      state,
      stack: (yield* readEnv("ALCHEMY_VIEWER_STACK")) ?? undefined,
      stage: (yield* readEnv("ALCHEMY_VIEWER_STAGE")) ?? undefined,
      // Lambda Function URLs buffer responses (BUFFERED invoke mode) —
      // an unending SSE stream would never flush. `poll` closes after
      // each snapshot and lets EventSource's auto-reconnect poll.
      sse: "poll",
    });
    return {
      fetch: handle.pipe(
        Effect.catchCause((cause) =>
          HttpServerResponse.json(
            { error: Cause.pretty(cause) },
            { status: 500 },
          ),
        ),
      ),
    };
  }),
) {}
