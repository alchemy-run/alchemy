import { fromApiKey } from "@distilled.cloud/neon/Credentials";
import { expect, test as unit } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { OwnedBySomeoneElse, Unowned } from "@/AdoptPolicy.ts";
import { Realtime, RealtimeProvider, type RealtimeAttributes } from "@/Neon/Realtime.ts";

const tags = ["unit", "provider:neon", "provider:neon:realtime", "local"];

const scope = { projectId: "proj-unit", branchId: "br-unit" };
const path = `/projects/${scope.projectId}/branches/${scope.branchId}/realtime`;
const url = "https://realtime.test.neon.tech/v1/proj-unit/br-unit";
const context = {
  id: "Realtime",
  fqn: "Realtime",
  instanceId: "realtime-unit",
  bindings: [],
  session: { emit: () => Effect.void, done: () => Effect.void, note: () => Effect.void },
};

interface FakeRealtime {
  enabled: boolean;
  /** GETs left before a pending change settles. */
  settleAfter: number;
  origins: string[] | undefined;
  secret: string | undefined;
  revision: number;
}

/**
 * A scripted Neon Realtime API: enable/disable are asynchronous and the
 * secret only exists once provisioning has settled, as documented.
 */
const fakeNeon = (initial: Partial<FakeRealtime> = {}) => {
  const state: FakeRealtime = {
    enabled: false,
    settleAfter: 0,
    origins: undefined,
    secret: undefined,
    revision: 0,
    ...initial,
  };
  const calls: string[] = [];
  const reply = (request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) =>
    HttpClientResponse.fromWeb(request, Response.json(body, { status }));
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const requestPath = new URL(request.url).pathname.replace(/^\/api\/v2/, "");
      const body =
        request.body._tag === "Uint8Array"
          ? (JSON.parse(new TextDecoder().decode(request.body.body)) as {
              allowed_origins?: string[];
            })
          : {};
      calls.push(`${request.method} ${requestPath}`);
      if (request.headers.authorization !== "Bearer unit-fixture-only") {
        return reply(request, { message: "unauthorized" }, 401);
      }
      if (requestPath === path && request.method === "GET") {
        const pending = state.settleAfter > 0;
        if (pending) state.settleAfter -= 1;
        return reply(request, {
          enabled: state.enabled,
          pending,
          ...(state.enabled && !pending ? { invocation_url: url, revision: state.revision } : {}),
          ...(state.enabled ? { allowed_origins: state.origins ?? [] } : {}),
        });
      }
      if (requestPath === path && request.method === "POST") {
        state.enabled = true;
        state.revision += 1;
        state.settleAfter = 1;
        if (body.allowed_origins !== undefined) state.origins = body.allowed_origins;
        state.secret ??= `nrt_live_1_${state.revision}`;
        return reply(request, {}, 202);
      }
      if (requestPath === path && request.method === "DELETE") {
        state.enabled = false;
        state.secret = undefined;
        state.origins = undefined;
        state.settleAfter = 1;
        return reply(request, {}, 202);
      }
      if (requestPath === `${path}/secret` && request.method === "GET") {
        return state.enabled && state.settleAfter === 0 && state.secret
          ? reply(request, { secret: state.secret, pending: false })
          : reply(request, { code: "NOT_FOUND", message: "Realtime secret not provisioned" }, 404);
      }
      return reply(request, { message: `unexpected ${request.method} ${requestPath}` }, 500);
    }),
  );
  return { state, calls, client };
};

const withFake = <A, E, R>(fake: ReturnType<typeof fakeNeon>, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(RealtimeProvider()),
    Effect.provideService(HttpClient.HttpClient, fake.client),
    Effect.provide(fromApiKey({ apiKey: Redacted.make("unit-fixture-only") })),
  );

const expectAttributes = (attrs: RealtimeAttributes, origins: string[]) => {
  expect(attrs.projectId).toBe(scope.projectId);
  expect(attrs.branchId).toBe(scope.branchId);
  expect(attrs.url).toBe(url);
  expect(Redacted.isRedacted(attrs.secret)).toBe(true);
  expect(Redacted.value(attrs.secret)).toMatch(/^nrt_live_1_/);
  expect(attrs.allowedOrigins).toEqual(origins);
};

unit.live(
  "reconcile enables Realtime, waits for provisioning and returns the redacted secret",
  () =>
    Effect.gen(function* () {
      const fake = fakeNeon();
      const origins = ["https://app.example.com", "http://localhost:3000"];
      const attrs = yield* withFake(
        fake,
        Effect.gen(function* () {
          const provider = yield* Realtime.Provider;
          return yield* provider.reconcile({
            ...context,
            news: { branch: scope, allowedOrigins: origins },
            olds: undefined,
            output: undefined,
          });
        }),
      );
      expectAttributes(attrs, origins);
      expect(attrs.revision).toBe(1);
      expect(fake.state.origins).toEqual(origins);
      // observe → enable → poll until settled → secret
      expect(fake.calls).toEqual([
        `GET ${path}`,
        `POST ${path}`,
        `GET ${path}`,
        `GET ${path}`,
        `GET ${path}/secret`,
      ]);
      // The secret never leaks through the attributes' string form.
      expect(JSON.stringify(attrs)).not.toContain("nrt_live_1_");
    }),
  { tags, timeout: 30_000 },
);

unit.live(
  "reconcile applies drifted origins in place and is a no-op when they match",
  () =>
    Effect.gen(function* () {
      const fake = fakeNeon({
        enabled: true,
        origins: ["https://old.example.com"],
        secret: "nrt_live_1_existing",
        revision: 3,
      });
      const output: RealtimeAttributes = {
        ...scope,
        url,
        secret: Redacted.make("nrt_live_1_existing"),
        allowedOrigins: ["https://old.example.com"],
        revision: 3,
      };
      const program = (allowedOrigins: string[] | undefined) =>
        Effect.gen(function* () {
          const provider = yield* Realtime.Provider;
          return yield* provider.reconcile({
            ...context,
            news: { branch: scope, allowedOrigins },
            olds: { branch: scope, allowedOrigins: output.allowedOrigins },
            output,
          });
        });
      const updated = yield* withFake(fake, program(["https://new.example.com/"]));
      expect(updated.allowedOrigins).toEqual(["https://new.example.com/"]);
      expect(updated.revision).toBe(4);
      expect(fake.calls.filter((call) => call.startsWith("POST"))).toHaveLength(1);
      fake.calls.length = 0;
      // Trailing slashes and case are not drift; neither is an unmanaged list.
      const unchanged = yield* withFake(fake, program(["HTTPS://new.example.com"]));
      expect(unchanged.revision).toBe(4);
      const unmanaged = yield* withFake(fake, program(undefined));
      expect(unmanaged.revision).toBe(4);
      expect(fake.calls.filter((call) => call.startsWith("POST"))).toHaveLength(0);
      expect(Redacted.value(unmanaged.secret)).toBe("nrt_live_1_existing");
    }),
  { tags, timeout: 30_000 },
);

unit.live(
  "reconcile re-enables Realtime disabled out-of-band and read reports the drift",
  () =>
    Effect.gen(function* () {
      const fake = fakeNeon();
      const output: RealtimeAttributes = {
        ...scope,
        url,
        secret: Redacted.make("nrt_live_1_lost"),
        allowedOrigins: [],
        revision: 1,
      };
      const read = yield* withFake(
        fake,
        Effect.gen(function* () {
          const provider = yield* Realtime.Provider;
          return yield* provider.read!({ ...context, olds: { branch: scope }, output });
        }),
      );
      expect(read).toBeUndefined();
      const recovered = yield* withFake(
        fake,
        Effect.gen(function* () {
          const provider = yield* Realtime.Provider;
          return yield* provider.reconcile({
            ...context,
            news: { branch: scope },
            olds: { branch: scope },
            output,
          });
        }),
      );
      expectAttributes(recovered, []);
      expect(fake.calls.filter((call) => call.startsWith("POST"))).toHaveLength(1);
    }),
  { tags, timeout: 30_000 },
);

unit.live(
  "foreign Realtime is Unowned on read and refused by reconcile until adopted",
  () =>
    Effect.gen(function* () {
      const fake = fakeNeon({
        enabled: true,
        origins: ["*"],
        secret: "nrt_live_1_foreign",
        revision: 7,
      });
      const provider = withFake(fake, Realtime.Provider);
      const read = yield* withFake(
        fake,
        Effect.flatMap(provider, (provider) =>
          provider.read!({ ...context, olds: { branch: scope }, output: undefined }),
        ),
      );
      expect(Unowned.is(read)).toBe(true);
      const refused = yield* withFake(
        fake,
        Effect.flatMap(provider, (provider) =>
          provider.reconcile({
            ...context,
            news: { branch: scope, allowedOrigins: ["https://app.example.com"] },
            olds: undefined,
            output: undefined,
          }),
        ),
      ).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(OwnedBySomeoneElse);
      expect(fake.state.origins).toEqual(["*"]);
      // Adoption: the engine hands `read`'s (branded, structurally plain)
      // attributes back as `output` with no `olds`.
      const adopted = yield* withFake(
        fake,
        Effect.flatMap(provider, (provider) =>
          provider.reconcile({
            ...context,
            news: { branch: scope, allowedOrigins: ["https://app.example.com"] },
            olds: undefined,
            output: read as RealtimeAttributes,
          }),
        ),
      );
      expectAttributes(adopted, ["https://app.example.com"]);
      expect(adopted.revision).toBe(8);
    }),
  { tags, timeout: 30_000 },
);

unit.live(
  "delete disables Realtime once and tolerates an already-disabled branch",
  () =>
    Effect.gen(function* () {
      const fake = fakeNeon({ enabled: true, secret: "nrt_live_1_gone", revision: 2 });
      const output: RealtimeAttributes = {
        ...scope,
        url,
        secret: Redacted.make("nrt_live_1_gone"),
        allowedOrigins: [],
        revision: 2,
      };
      const remove = Effect.gen(function* () {
        const provider = yield* Realtime.Provider;
        yield* provider.delete({ ...context, olds: { branch: scope }, output });
      });
      yield* withFake(fake, remove);
      expect(fake.state.enabled).toBe(false);
      expect(fake.state.secret).toBeUndefined();
      expect(fake.calls.filter((call) => call.startsWith("DELETE"))).toHaveLength(1);
      fake.calls.length = 0;
      yield* withFake(fake, remove);
      expect(fake.calls).toEqual([`GET ${path}`]);
    }),
  { tags, timeout: 30_000 },
);

unit.live(
  "diff replaces on a branch change, updates on drift and is a no-op otherwise",
  () =>
    Effect.gen(function* () {
      const fake = fakeNeon({
        enabled: true,
        origins: ["https://app.example.com"],
        secret: "nrt_live_1_diff",
        revision: 1,
      });
      const output: RealtimeAttributes = {
        ...scope,
        url,
        secret: Redacted.make("nrt_live_1_diff"),
        allowedOrigins: ["https://app.example.com"],
        revision: 1,
      };
      const olds = { branch: scope, allowedOrigins: ["https://app.example.com"] };
      const diff = (news: typeof olds | { branch: { projectId: string; branchId: string } }) =>
        Effect.gen(function* () {
          const provider = yield* Realtime.Provider;
          return yield* provider.diff!({
            ...context,
            olds,
            news,
            oldBindings: [],
            newBindings: [],
            output,
          });
        });
      expect(
        yield* withFake(
          fake,
          diff({ branch: { projectId: scope.projectId, branchId: "br-other" } }),
        ),
      ).toEqual({ action: "replace" });
      expect(
        yield* withFake(fake, diff({ branch: scope, allowedOrigins: ["https://b.example.com"] })),
      ).toEqual({ action: "update" });
      expect(
        yield* withFake(
          fake,
          diff({ branch: scope, allowedOrigins: ["https://app.example.com/"] }),
        ),
      ).toBeUndefined();
      expect(yield* withFake(fake, diff({ branch: scope }))).toBeUndefined();
      fake.state.enabled = false;
      expect(yield* withFake(fake, diff(olds))).toEqual({ action: "update" });
    }),
  { tags, timeout: 30_000 },
);
