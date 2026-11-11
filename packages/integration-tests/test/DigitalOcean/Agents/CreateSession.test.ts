import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { Credentials, getHarnessSession } from "@distilled.cloud/digitalocean";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { logLevel, skipSlow, waitForAppHost } from "../support.ts";
import SessionApp from "./fixtures/session-app.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

// A team holds one registry, so the app deploys, starts a session per
// request and is destroyed inside one test holding the registry lock.
test.provider.skipIf(skipSlow)(
  "an App starts an agent session, runs a command in its sandbox, deletes it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { apiKey } = yield* yield* Credentials;
      const ambient = yield* ConfigProvider.ConfigProvider;
      const { url } = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* SessionApp;
          return { url: app.url };
        }).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.orElse(
              ConfigProvider.fromUnknown({ DO_TEST_KEY: Redacted.value(apiKey) }),
              ambient,
            ),
          ),
        ),
      );
      yield* waitForAppHost(url);
      const client = yield* HttpClient.HttpClient;
      const body = (yield* client.get(url).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? response.json
            : Effect.fail(new Error(`HTTP ${response.status}`)),
        ),
        Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
      )) as { id: string; stdout: string };
      expect(body.stdout).toEqual("from-the-sandbox");
      // The request's scope deleted the session it started.
      const status = yield* getHarnessSession({ session_id: body.id }).pipe(
        Effect.map((r) => r.session?.status ?? "missing"),
        Effect.catchTag("NotFound", () => Effect.succeed("gone")),
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (s) =>
            ["gone", "SESSION_STATUS_DESTROYING", "SESSION_STATUS_DESTROYED"].includes(s),
          times: 12,
        }),
      );
      expect(["gone", "SESSION_STATUS_DESTROYING", "SESSION_STATUS_DESTROYED"]).toContain(status);
      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:digitalocean", "provider:digitalocean:agents", "live"],
    timeout: 2_700_000,
    exclusive: "digitalocean:registry",
  },
);
