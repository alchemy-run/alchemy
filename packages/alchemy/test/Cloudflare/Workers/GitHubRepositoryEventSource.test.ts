import { GitHubRepositoryEventSourceLive } from "@/Cloudflare/Workers/GitHubRepositoryEventSource.ts";
import { Worker } from "@/Cloudflare/Workers/Worker.ts";
import { WorkerEnvironment } from "@/Cloudflare/Workers/WorkerRuntime.ts";
import { makeWorkerRuntimeContext } from "@/Cloudflare/Workers/WorkerRuntimeContext.ts";
import {
  consumeRepositoryEvents,
  webhookSecretEnvName,
} from "@/GitHub/RepositoryEventSource.ts";
import { RuntimeContext, packEnvValue } from "@/RuntimeContext.ts";
import { ConflictingWebhookEndpoint } from "@/Serverless/Webhook.ts";
import { expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { createHmac } from "node:crypto";

const WorkerHost = Context.Service<Worker, Worker>(Worker.Self.key);

const runtimeOnly = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = globalThis.__ALCHEMY_RUNTIME__;
      globalThis.__ALCHEMY_RUNTIME__ = true;
      return previous;
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        globalThis.__ALCHEMY_RUNTIME__ = previous;
      }),
  );

it.effect(
  "GitHub shares one receiver, filters events, and rejects partial acknowledgement",
  () =>
    runtimeOnly(
      Effect.gen(function* () {
        const ctx = makeWorkerRuntimeContext("github-webhooks");
        const props = {
          owner: "acme",
          repository: "api",
          secret: Redacted.make("test-secret"),
        };
        const delivered: string[] = [];
        let issueCalls = 0;
        let fail = true;
        let applicationCalls = 0;
        const register = Effect.gen(function* () {
          yield* consumeRepositoryEvents(
            { ...props, events: ["push"] },
            (event) =>
              Effect.sync(() => {
                delivered.push(event.id);
              }),
          );
          yield* consumeRepositoryEvents({ ...props, events: ["push"] }, () =>
            Effect.suspend(() =>
              fail ? Effect.die("subscriber failure") : Effect.void,
            ),
          );
          yield* consumeRepositoryEvents({ ...props, events: ["issues"] }, () =>
            Effect.sync(() => {
              issueCalls++;
            }),
          );
          yield* ctx.serve(
            Effect.sync(() => {
              applicationCalls++;
              return HttpServerResponse.text("application");
            }),
          );
        }).pipe(
          Effect.provide(GitHubRepositoryEventSourceLive),
          Effect.provideService(WorkerHost, ctx as unknown as Worker),
          Effect.provideService(RuntimeContext, ctx),
        );
        yield* register;
        const exports = yield* ctx.exports;
        const env = {
          [webhookSecretEnvName(props)]: packEnvValue(props.secret),
        };
        let reads = 0;
        const send = (name: string, valid = true) =>
          Effect.gen(function* () {
            const body = JSON.stringify({ action: "opened" });
            const signature = yield* Effect.sync(() =>
              createHmac("sha256", "test-secret").update(body).digest("hex"),
            );
            const request = new Request(
              "https://worker.example/__alchemy/github/acme/api",
              {
                method: "POST",
                body,
                headers: {
                  "x-github-event": name,
                  "x-github-delivery": "delivery-1",
                  "x-hub-signature-256": `sha256=${valid ? signature : "0".repeat(64)}`,
                },
              },
            );
            const text = request.text.bind(request);
            request.text = () => {
              reads++;
              return text();
            };
            const [program, services] = exports.default.fetch(
              request,
              env,
              {} as ExecutionContext,
            );
            return yield* (program as Effect.Effect<Response>).pipe(
              Effect.provide(services as Context.Context<never>),
              Effect.provideService(WorkerEnvironment, env),
            );
          });
        expect((yield* send("push")).status).toBe(503);
        expect(delivered).toEqual(["delivery-1"]);
        expect(issueCalls).toBe(0);
        expect(reads).toBe(1);
        fail = false;
        expect((yield* send("push")).status).toBe(202);
        expect(delivered).toEqual(["delivery-1", "delivery-1"]);
        expect((yield* send("issues")).status).toBe(202);
        expect(issueCalls).toBe(1);
        expect((yield* send("push", false)).status).toBe(401);
        expect(delivered).toHaveLength(2);
        expect(applicationCalls).toBe(0);
        const [program, services] = exports.default.fetch(
          new Request("https://worker.example/application"),
          env,
          {} as ExecutionContext,
        );
        expect(
          (yield* (program as Effect.Effect<Response>).pipe(
            Effect.provide(services as Context.Context<never>),
          )).status,
        ).toBe(200);
        expect(applicationCalls).toBe(1);
      }),
    ),
  { exclusive: true },
);

it.effect(
  "GitHub rejects repository and secret-binding identities reused across paths",
  () =>
    runtimeOnly(
      Effect.gen(function* () {
        const secret = Redacted.make("shared-secret");
        for (const [first, second] of [
          [
            { repository: "api", path: "/first" },
            { repository: "api", path: "/second" },
          ],
          [
            { repository: "a-b", path: "/first" },
            { repository: "a_b", path: "/second" },
          ],
        ]) {
          const ctx = makeWorkerRuntimeContext("github-identity-conflict");
          const exit = yield* Effect.gen(function* () {
            yield* consumeRepositoryEvents(
              { owner: "acme", secret, ...first! },
              () => Effect.void,
            );
            yield* consumeRepositoryEvents(
              { owner: "acme", secret, ...second! },
              () => Effect.void,
            );
          }).pipe(
            Effect.provide(GitHubRepositoryEventSourceLive),
            Effect.provideService(WorkerHost, ctx as unknown as Worker),
            Effect.provideService(RuntimeContext, ctx),
            Effect.exit,
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit))
            expect(Cause.squash(exit.cause)).toBeInstanceOf(
              ConflictingWebhookEndpoint,
            );
        }
      }),
    ),
  { exclusive: true },
);

it.effect(
  "GitHub rejects conflicting signing secrets on a shared endpoint",
  () =>
    runtimeOnly(
      Effect.gen(function* () {
        const ctx = makeWorkerRuntimeContext("github-conflict");
        const exit = yield* Effect.gen(function* () {
          yield* consumeRepositoryEvents(
            {
              owner: "acme",
              repository: "api",
              secret: Redacted.make("first"),
            },
            () => Effect.void,
          );
          yield* consumeRepositoryEvents(
            {
              owner: "acme",
              repository: "api",
              secret: Redacted.make("second"),
            },
            () => Effect.void,
          );
        }).pipe(
          Effect.provide(GitHubRepositoryEventSourceLive),
          Effect.provideService(WorkerHost, ctx as unknown as Worker),
          Effect.provideService(RuntimeContext, ctx),
          Effect.exit,
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(Cause.squash(exit.cause)).toBeInstanceOf(
            ConflictingWebhookEndpoint,
          );
      }),
    ),
  { exclusive: true },
);
