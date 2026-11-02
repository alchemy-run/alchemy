import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as functions from "@distilled.cloud/stackit/functions";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitTags } from "../helpers.ts";
import { Ping } from "./fixtures/stack.ts";
import FunctionsBindingsWorker from "./fixtures/worker.ts";
import { noBuiltFunctions } from "./helpers.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitFunctionsBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* FunctionsBindingsWorker;
    const ping = yield* Ping;
    return {
      url: worker.url.as<string>(),
      functionId: ping.functionId,
      projectId: ping.projectId,
      name: ping.name,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

describe
  .skipIf(noBuiltFunctions)
  .sequential(
    "STACKIT Functions bindings on a Cloudflare Worker",
    { tags: [...stackitTags("functions", "bindings"), "provider:cloudflare"] },
    () => {
      const stack = beforeAll(deploy(Stack), { timeout: 1_200_000 });
      afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 900_000 });

      // A fresh workers.dev URL, the created key and its memberships take a while
      // to propagate: retry until the route answers `ok`, then report the last
      // answer so a real failure shows its STACKIT error.
      const call = (route: string, params: Record<string, string> = {}) =>
        Effect.gen(function* () {
          const { url } = yield* stack;
          const query = new URLSearchParams(params).toString();
          return yield* HttpClient.get(`${url}${route}?${query}`).pipe(
            Effect.timeout("30 seconds"),
            Effect.flatMap((response) => response.json),
            Effect.map((body) => body as Body),
            Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
            Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
            Effect.catch((body) => Effect.succeed(body as Body)),
          );
        });

      const currentRevision = Effect.gen(function* () {
        const { projectId, functionId } = yield* stack;
        const fn = yield* functions.getFunction({
          projectId: projectId!,
          functionId: functionId!,
        });
        return fn.current_revision!;
      });

      describe("GetFunction", () => {
        test(
          "reads the bound function",
          Effect.gen(function* () {
            const { functionId, name } = yield* stack;
            const body = yield* call("/get-function");
            expectOk(body);
            expect(body.result).toMatchObject({ id: functionId, name, state: "ACTIVE" });
          }),
          { timeout: 180_000 },
        );
      });

      describe("ListFunctions", () => {
        test(
          "lists the bound function among its project's",
          Effect.gen(function* () {
            const { functionId } = yield* stack;
            const body = yield* call("/list-functions");
            expectOk(body);
            expect(body.result.functions.map((fn: { id: string }) => fn.id)).toContain(functionId);
          }),
          { timeout: 180_000 },
        );
      });

      describe("GetRevision", () => {
        test.provider(
          "reads the function's current revision",
          (_stack) =>
            Effect.gen(function* () {
              const revisionId = yield* currentRevision;
              const body = yield* call("/get-revision", { id: revisionId });
              expectOk(body);
              expect(body.result).toMatchObject({ id: revisionId, state: "ACTIVE" });
              expect(body.result.oci_reference).toMatch(/@sha256:[a-f0-9]{64}$/);
            }),
          { timeout: 180_000 },
        );
      });

      describe("ListRevisions", () => {
        test.provider(
          "lists the function's current revision",
          (_stack) =>
            Effect.gen(function* () {
              const revisionId = yield* currentRevision;
              const body = yield* call("/list-revisions");
              expectOk(body);
              expect(body.result.ids).toContain(revisionId);
            }),
          { timeout: 180_000 },
        );
      });

      describe("Invoke", () => {
        test(
          "calls the function at its URL",
          Effect.gen(function* () {
            const body = yield* call("/invoke", { path: "/from-worker" });
            expectOk(body);
            expect(body.result).toEqual({
              form: "async",
              greeting: "hello from async",
              path: "/from-worker",
            });
          }),
          { timeout: 180_000 },
        );
      });
    },
  );
