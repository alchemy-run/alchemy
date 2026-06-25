import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Binding from "../../Binding.ts";
import {
  RepositoryEventSource,
  webhookPath,
  webhookSecretEnvName,
  type RepositoryEventSourceProps,
  type RepositoryEventSourceService,
  type WebhookEvent,
} from "../../GitHub/RepositoryEventSource.ts";
import { Webhook } from "../../GitHub/Webhook.ts";
import * as Output from "../../Output.ts";
import { isWorker, isWorkerEvent, Worker } from "./Worker.ts";
import type { Providers } from "../Providers.ts";

/**
 * Deploy-time half of the GitHub event source for Cloudflare Workers.
 *
 * Provisions a {@link Webhook} on the repository whose delivery URL points
 * at this Worker (at a deterministic per-repo path). The webhook secret is
 * bound onto the Worker separately by the runtime layer, via an `Output`
 * accessor, so the runtime can verify delivery signatures.
 * @binding
 * @product Workers
 * @category Workers & Compute
 */
export class GitHubRepositoryEventSourcePolicy extends Binding.Policy<
  GitHubRepositoryEventSourcePolicy,
  (props: RepositoryEventSourceProps) => Effect.Effect<void>,
  Providers
>()("GitHub.RepositoryEventSourcePolicy") {}

export const GitHubRepositoryEventSourcePolicyLive =
  GitHubRepositoryEventSourcePolicy.layer.effect(
    Effect.gen(function* () {
      // Loosely-typed constructor — yielding the resource class erases its
      // `GitHub.Providers` requirement so it fits the policy's `Effect<void>`
      // return type. The requirement is satisfied by the stack at plan time.
      const createWebhook = yield* Webhook;

      return Effect.fn(function* (host, props) {
        if (!isWorker(host)) {
          return yield* Effect.die(
            `GitHub.events(...).subscribe(...) is only supported on ` +
              `Cloudflare.Worker hosts (got '${host.Type}').`,
          );
        }
        const worker = host as Worker;
        const path = webhookPath(props);

        yield* createWebhook(`${props.owner}/${props.repository}`, {
          owner: props.owner,
          repository: props.repository,
          url: Output.interpolate`${worker.url}${path}`,
          events: [...(props.events ?? ["push"])],
          secret: props.secret,
          contentType: "json",
        });
      });
    }),
  );

/**
 * Runtime half of the GitHub event source for Cloudflare Workers.
 *
 * Registers a `fetch` listener that claims requests on the repository's
 * delivery path, verifies the `HMAC-SHA256` signature against the bound
 * secret, and forwards each delivery to the subscriber as a single-element
 * `Stream`. Requests on any other path fall through to the Worker's own
 * `fetch` handler.
 */
export const GitHubRepositoryEventSourceLive = Layer.effect(
  RepositoryEventSource,
  Effect.gen(function* () {
    const policy = yield* GitHubRepositoryEventSourcePolicy;
    const ctx = yield* Worker;

    return Effect.fn(function* (
      props: RepositoryEventSourceProps,
      process: (event: WebhookEvent) => Effect.Effect<void, never, never>,
    ) {
      yield* policy(props);

      const path = webhookPath(props);

      // Bind the webhook secret as a Worker env accessor under a
      // deterministic key. This single `yield*` does both halves: at plan
      // time it registers a `secret_text` binding (the engine deploys
      // `Redacted` values as Cloudflare secrets), and it returns an Effect
      // that reads the value back from `WorkerEnvironment` at runtime —
      // reconstructing the `Redacted` wrapper. No direct `event.env` access.
      const secret = props.secret
        ? yield* Output.named(
            Output.asOutput(props.secret),
            webhookSecretEnvName(props),
          )
        : undefined;

      yield* ctx.listen((event) => {
        if (!isWorkerEvent(event) || event.type !== "fetch") return;
        const request = event.input as cf.Request;

        let pathname: string;
        try {
          pathname = new URL(request.url).pathname;
        } catch {
          return;
        }
        // Not our delivery path — let the Worker's own handler take it.
        if (pathname !== path) return;

        return handleDelivery(request, secret, process);
      });
    }) as RepositoryEventSourceService;
  }),
);

const handleDelivery = <Req>(
  request: cf.Request,
  // The bound secret accessor (see `Output.named` above). `undefined` when
  // no secret was configured, in which case deliveries are accepted
  // unverified.
  secret: Effect.Effect<Redacted.Redacted<string> | undefined> | undefined,
  process: (event: WebhookEvent<any>) => Effect.Effect<void, never, Req>,
): Effect.Effect<Response, never, Req> =>
  Effect.gen(function* () {
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    const body = yield* Effect.promise(() =>
      (request as unknown as Request).text(),
    );

    if (secret !== undefined) {
      const resolved = yield* secret;
      const signature = request.headers.get("x-hub-signature-256") ?? undefined;
      const valid = yield* verifySignature(
        resolved ? Redacted.value(resolved) : undefined,
        body,
        signature,
      );
      if (!valid) {
        return new Response("invalid signature", { status: 401 });
      }
    }

    const name = request.headers.get("x-github-event") ?? "unknown";
    const id = request.headers.get("x-github-delivery") ?? "";

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      payload = body;
    }

    // The wire shape matches `EmitterWebhookEvent`, but the runtime can't
    // statically prove `name`/`payload` line up with a specific member of
    // the discriminated union — GitHub's headers are the source of truth, so
    // cast across the boundary.
    const delivery = { id, name, payload } as unknown as WebhookEvent;

    yield* process(delivery).pipe(Effect.orDie);

    return new Response(null, { status: 202 });
  });

const verifySignature = (
  secret: string | undefined,
  body: string,
  signature: string | undefined,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (!secret || !signature || !signature.startsWith("sha256=")) {
      return false;
    }
    const expected = yield* Effect.promise(async () => {
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const digest = await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(body),
      );
      const hex = Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      return `sha256=${hex}`;
    });
    return timingSafeEqual(expected, signature);
  });

/**
 * Constant-time string comparison. Avoids leaking signature bytes through
 * early-exit timing differences. `crypto.subtle.timingSafeEqual` isn't
 * available on Workers without `nodejs_compat`, so we roll a small one.
 */
const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
};
