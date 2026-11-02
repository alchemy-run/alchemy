import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const Logs = Stackit.Logs.Instance("LogsBindingsInstance", {
  retentionDays: 1,
  // A Worker's egress addresses aren't a fixed range, and the data bindings have to reach
  // the instance. Nothing but this suite's lines lives on it.
  acl: ["0.0.0.0/0"],
});

const tokenFor = (id: string, permissions: Array<"read" | "write">) =>
  Logs.pipe(
    Effect.flatMap((instance) =>
      Stackit.Logs.AccessToken(id, { instanceId: instance.instanceId, permissions }),
    ),
  );

export const Reader = tokenFor("LogsBindingsReader", ["read"]);
export const Writer = tokenFor("LogsBindingsWriter", ["write"]);
export const ReaderWriter = tokenFor("LogsBindingsReaderWriter", ["read", "write"]);

export const PolicySubject = Stackit.IAM.ServiceAccount("LogsBindingsPolicySubject", {});
export const Policy = Effect.gen(function* () {
  const instance = yield* Logs;
  const subject = yield* PolicySubject;
  return yield* Stackit.Logs.AccessPolicy("LogsBindingsPolicy", {
    instanceId: instance.instanceId,
    email: subject.email,
    permissions: ["read"],
  });
});

/**
 * A Cloudflare Worker with every Logs binding. One route per binding; each answers
 * `{ ok, result | error }` so a failure surfaces the error in the test. Values of tokens
 * never leave the Worker.
 */
export default class LogsBindingsWorker extends Cloudflare.Worker<LogsBindingsWorker>()(
  "StackitLogsBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const instance = yield* Logs;
    const getInstance = yield* Stackit.Logs.GetInstance(instance);
    const listInstances = yield* Stackit.Logs.ListInstances(instance);
    const createAccessToken = yield* Stackit.Logs.CreateAccessToken(instance);
    const getAccessToken = yield* Stackit.Logs.GetAccessToken(instance);
    const listAccessTokens = yield* Stackit.Logs.ListAccessTokens(instance);
    const deleteAccessToken = yield* Stackit.Logs.DeleteAccessToken(instance);
    const deleteExpired = yield* Stackit.Logs.DeleteExpiredAccessTokens(instance);
    const getAccessPolicy = yield* Stackit.Logs.GetAccessPolicy(instance);
    const listAccessPolicies = yield* Stackit.Logs.ListAccessPolicies(instance);
    const read = yield* Stackit.Logs.ReadInstance(yield* Reader);
    const write = yield* Stackit.Logs.WriteInstance(yield* Writer);
    const readWrite = yield* Stackit.Logs.ReadWriteInstance(yield* ReaderWriter);

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const id = url.searchParams.get("id") ?? "";
        const app = url.searchParams.get("app") ?? "bindings";
        const query = `{app="${app}"}`;
        const nanos = `${yield* Clock.currentTimeMillis}000000`;
        const push = { streams: [{ stream: { app }, values: [[nanos, `line from ${app}`]] }] };
        const otlp = {
          resourceLogs: [
            {
              resource: { attributes: [{ key: "service.name", value: { stringValue: app } }] },
              scopeLogs: [
                {
                  logRecords: [
                    {
                      timeUnixNano: nanos,
                      severityText: "INFO",
                      body: { stringValue: `otlp from ${app}` },
                    },
                  ],
                },
              ],
            },
          ],
        };
        switch (url.pathname) {
          case "/get-instance":
            return yield* respond(getInstance({}));
          case "/list-instances":
            return yield* respond(listInstances({}));
          case "/mint-and-revoke-token":
            // The id; the value never leaves the Worker.
            return yield* respond(
              Effect.gen(function* () {
                const minted = yield* createAccessToken({
                  displayName: `minted-${app}`,
                  permissions: ["read"],
                  lifetime: 1,
                });
                const found = yield* getAccessToken({ tId: minted.id });
                yield* deleteAccessToken({ tId: minted.id });
                return { id: minted.id, valueReturned: minted.accessToken !== undefined, found };
              }),
            );
          case "/get-token":
            return yield* respond(getAccessToken({ tId: id }));
          case "/list-tokens":
            return yield* respond(listAccessTokens({}));
          case "/delete-token":
            return yield* respond(deleteAccessToken({ tId: id }));
          case "/delete-expired":
            return yield* respond(deleteExpired({}));
          case "/get-policy":
            return yield* respond(getAccessPolicy({ pId: id }));
          case "/list-policies":
            return yield* respond(listAccessPolicies({}));
          case "/read/query-range":
            return yield* respond(read.queryRange({ query, since: "1h", limit: 100 }));
          case "/read/query":
            return yield* respond(read.query({ query: `sum(count_over_time(${query}[1h]))` }));
          case "/write/push":
            return yield* respond(write.push(push));
          case "/write/push-otlp":
            return yield* respond(write.pushOtlp(otlp));
          case "/read-write/roundtrip":
            return yield* respond(
              Effect.gen(function* () {
                yield* readWrite.push(push);
                return yield* readWrite.queryRange({ query, since: "1h", limit: 100 });
              }),
            );
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(Stackit.Logs.GetInstanceHttp),
    Effect.provide(Stackit.Logs.ListInstancesHttp),
    Effect.provide(Stackit.Logs.CreateAccessTokenHttp),
    Effect.provide(Stackit.Logs.GetAccessTokenHttp),
    Effect.provide(Stackit.Logs.ListAccessTokensHttp),
    Effect.provide(Stackit.Logs.DeleteAccessTokenHttp),
    Effect.provide(Stackit.Logs.DeleteExpiredAccessTokensHttp),
    Effect.provide(Stackit.Logs.GetAccessPolicyHttp),
    Effect.provide(Stackit.Logs.ListAccessPoliciesHttp),
    Effect.provide(Stackit.Logs.ReadInstanceHttp),
    Effect.provide(Stackit.Logs.WriteInstanceHttp),
    Effect.provide(Stackit.Logs.ReadWriteInstanceHttp),
  ),
) {}
