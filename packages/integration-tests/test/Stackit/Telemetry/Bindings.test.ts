import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitTags } from "../helpers.ts";
import TelemetryBindingsWorker, { AuditLogs, LinkToken, Siem } from "./fixtures/router-worker.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitTelemetryBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* TelemetryBindingsWorker;
    const router = yield* AuditLogs;
    const destination = yield* Siem;
    const token = yield* LinkToken;
    return {
      url: worker.url.as<string>(),
      routerId: router.routerId,
      destinationId: destination.destinationId,
      accessTokenId: token.accessTokenId,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

describe.sequential(
  "STACKIT Telemetry Router bindings on a Cloudflare Worker",
  { tags: [...stackitTags("telemetry", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: 900_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 900_000 });

    // A fresh workers.dev URL, the created key and the account's memberships take a while
    // to propagate: retry until the route answers `ok`, then report the last answer so a
    // real failure shows its STACKIT error.
    const call = (route: string) =>
      Effect.gen(function* () {
        const { url } = yield* stack;
        return yield* HttpClient.get(`${url}${route}`).pipe(
          Effect.timeout("20 seconds"),
          Effect.flatMap((response) => response.json),
          Effect.map((body) => body as Body),
          Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
          Effect.catch((body) => Effect.succeed(body as Body)),
        );
      });

    const expectOk = (body: Body) =>
      expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

    const options = { timeout: 180_000 } as const;

    describe("GetRouter", () => {
      test(
        "reads the bound router",
        Effect.gen(function* () {
          const { routerId } = yield* stack;
          const body = yield* call("/get-router");
          expectOk(body);
          expect(body.result).toEqual({ id: routerId, status: "active" });
        }),
        options,
      );
    });

    describe("ListRouters", () => {
      test(
        "lists the routers of the bound router's project and region",
        Effect.gen(function* () {
          const { routerId } = yield* stack;
          const body = yield* call("/list-routers");
          expectOk(body);
          expect(body.result).toContain(routerId);
        }),
        options,
      );
    });

    describe("GetDestination", () => {
      test(
        "reads the bound destination",
        Effect.gen(function* () {
          const { destinationId } = yield* stack;
          const body = yield* call("/get-destination");
          expectOk(body);
          expect(body.result).toEqual({ id: destinationId, type: "OpenTelemetry" });
        }),
        options,
      );
    });

    describe("ListDestinations", () => {
      test(
        "lists the destinations on the bound router",
        Effect.gen(function* () {
          const { destinationId } = yield* stack;
          const body = yield* call("/list-destinations");
          expectOk(body);
          expect(body.result).toEqual([destinationId]);
        }),
        options,
      );
    });

    describe("GetAccessToken", () => {
      test(
        "reads the bound token, without its value",
        Effect.gen(function* () {
          const { accessTokenId } = yield* stack;
          const body = yield* call("/get-access-token");
          expectOk(body);
          expect(body.result).toEqual({ id: accessTokenId, status: "active" });
        }),
        options,
      );
    });

    describe("ListAccessTokens", () => {
      test(
        "lists the tokens of the bound router",
        Effect.gen(function* () {
          const { accessTokenId } = yield* stack;
          const body = yield* call("/list-access-tokens");
          expectOk(body);
          expect(body.result).toEqual([accessTokenId]);
        }),
        options,
      );
    });
  },
);
