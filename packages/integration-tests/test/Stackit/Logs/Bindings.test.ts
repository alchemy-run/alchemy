import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as logs from "@distilled.cloud/stackit/logs";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitEnvironment, stackitTags } from "../helpers.ts";
import LogsBindingsWorker, { Logs, Policy, PolicySubject, Reader } from "./fixtures/worker.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitLogsBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* LogsBindingsWorker;
    const instance = yield* Logs;
    const reader = yield* Reader;
    const policy = yield* Policy;
    const subject = yield* PolicySubject;
    return {
      url: worker.url.as<string>(),
      instanceId: instance.instanceId,
      displayName: instance.displayName,
      readerId: reader.accessTokenId,
      policyId: policy.accessPolicyId,
      subject: subject.email,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

const linesOf = (body: Body): string[] =>
  (body.result?.data?.result ?? []).flatMap((stream: { values: unknown[][] }) =>
    stream.values.map((value) => String(value[1])),
  );

// A token's lines, once pushed, take a moment to be queryable; the suite shares one
// instance, and a run ingests kilobytes. Pay-per-use, so it runs ungated (see `logs.ts`).
describe.sequential(
  "STACKIT Logs bindings on a Cloudflare Worker",
  { tags: [...stackitTags("logs", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: 900_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 900_000 });

    // A fresh workers.dev URL, the created key and the account's new memberships take a
    // while to propagate: retry until the route answers `ok`, then report the last answer
    // so a real failure shows its error.
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

    /** Poll a query route until it reports `line`. Bounded: about two minutes. */
    const untilLine = (route: string, app: string, line: string) =>
      call(route, { app }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (body) => linesOf(body).includes(line),
          times: 24,
        }),
      );

    const OPTIONS = { timeout: 300_000 } as const;

    describe("GetInstance", () => {
      test.provider(
        "reads the bound instance",
        (_stack) =>
          Effect.gen(function* () {
            const { instanceId } = yield* stack;
            const body = yield* call("/get-instance");
            expectOk(body);
            expect(body.result.id).toEqual(instanceId);
            expect(body.result.status).toEqual("active");
          }),
        OPTIONS,
      );
    });

    describe("ListInstances", () => {
      test.provider(
        "lists the bound instance",
        (_stack) =>
          Effect.gen(function* () {
            const { instanceId } = yield* stack;
            const body = yield* call("/list-instances");
            expectOk(body);
            expect(body.result.instances.map((item: { id: string }) => item.id)).toContain(
              instanceId,
            );
          }),
        OPTIONS,
      );
    });

    describe("CreateAccessToken", () => {
      test.provider(
        "mints a token, reads it and revokes it",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, region } = yield* stackitEnvironment;
            const { instanceId } = yield* stack;
            const body = yield* call("/mint-and-revoke-token", { app: "create" });
            expectOk(body);
            expect(body.result.valueReturned).toBe(true);
            expect(body.result.found.displayName).toEqual("minted-create");

            // Out of band: the route revoked what it minted.
            const { tokens } = yield* logs.listAccessTokens({
              projectId,
              regionId: region,
              instanceId,
            });
            expect(tokens.map((token) => token.id)).not.toContain(body.result.id);
          }),
        OPTIONS,
      );
    });

    describe("GetAccessToken", () => {
      test.provider(
        "reads a token, without its value",
        (_stack) =>
          Effect.gen(function* () {
            const { readerId } = yield* stack;
            const body = yield* call("/get-token", { id: readerId });
            expectOk(body);
            expect(body.result.id).toEqual(readerId);
            expect(body.result.status).toEqual("active");
            expect(body.result.accessToken).toBeUndefined();
          }),
        OPTIONS,
      );
    });

    describe("ListAccessTokens", () => {
      test.provider(
        "lists the deployed tokens",
        (_stack) =>
          Effect.gen(function* () {
            const { readerId } = yield* stack;
            const body = yield* call("/list-tokens");
            expectOk(body);
            expect(body.result.tokens.map((token: { id: string }) => token.id)).toContain(readerId);
          }),
        OPTIONS,
      );
    });

    describe("DeleteAccessToken", () => {
      test.provider(
        "revokes a token the test minted out of band",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, region } = yield* stackitEnvironment;
            const { instanceId } = yield* stack;
            const minted = yield* logs.createAccessToken({
              projectId,
              regionId: region,
              instanceId,
              displayName: "bindings-delete",
              permissions: ["read"],
            });
            const body = yield* call("/delete-token", { id: minted.id });
            expectOk(body);

            const { tokens } = yield* logs.listAccessTokens({
              projectId,
              regionId: region,
              instanceId,
            });
            expect(tokens.map((token) => token.id)).not.toContain(minted.id);
          }),
        OPTIONS,
      );
    });

    describe("DeleteExpiredAccessTokens", () => {
      test.provider(
        "leaves live tokens alone",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, region } = yield* stackitEnvironment;
            const { instanceId, readerId } = yield* stack;
            const body = yield* call("/delete-expired");
            expectOk(body);

            const { tokens } = yield* logs.listAccessTokens({
              projectId,
              regionId: region,
              instanceId,
            });
            expect(tokens.map((token) => token.id)).toContain(readerId);
          }),
        OPTIONS,
      );
    });

    describe("GetAccessPolicy", () => {
      test.provider(
        "reads the deployed policy",
        (_stack) =>
          Effect.gen(function* () {
            const { policyId, subject } = yield* stack;
            const body = yield* call("/get-policy", { id: policyId });
            expectOk(body);
            expect(body.result.email).toEqual(subject);
            expect(body.result.permissions).toEqual(["read"]);
          }),
        OPTIONS,
      );
    });

    describe("ListAccessPolicies", () => {
      test.provider(
        "lists the deployed policy",
        (_stack) =>
          Effect.gen(function* () {
            const { policyId } = yield* stack;
            const body = yield* call("/list-policies");
            expectOk(body);
            expect(body.result.policies.map((policy: { id: string }) => policy.id)).toContain(
              policyId,
            );
          }),
        OPTIONS,
      );
    });

    describe("WriteInstance", () => {
      test.provider(
        "pushes a line a read token then finds",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/write/push", { app: "write" });
            expectOk(body);
            const found = yield* untilLine("/read/query-range", "write", "line from write");
            expect(linesOf(found)).toContain("line from write");
          }),
        OPTIONS,
      );

      test.provider(
        "pushes an OTLP record",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/write/push-otlp", { app: "otlp" });
            expectOk(body);
          }),
        OPTIONS,
      );
    });

    describe("ReadInstance", () => {
      test.provider(
        "runs a metric query",
        (_stack) =>
          Effect.gen(function* () {
            const pushed = yield* call("/write/push", { app: "metric" });
            expectOk(pushed);
            yield* untilLine("/read/query-range", "metric", "line from metric");
            const body = yield* call("/read/query", { app: "metric" });
            expectOk(body);
            expect(body.result.data.resultType).toEqual("vector");
            expect(body.result.data.result.length).toBeGreaterThan(0);
          }),
        OPTIONS,
      );
    });

    describe("ReadWriteInstance", () => {
      test.provider(
        "pushes and queries with one token",
        (_stack) =>
          Effect.gen(function* () {
            const found = yield* untilLine(
              "/read-write/roundtrip",
              "roundtrip",
              "line from roundtrip",
            );
            expectOk(found);
            expect(linesOf(found)).toContain("line from roundtrip");
          }),
        OPTIONS,
      );
    });
  },
);
