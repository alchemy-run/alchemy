import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { Credentials, getMicrovm } from "@distilled.cloud/digitalocean";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { isGone, logLevel, skipSlow, waitForAppHost } from "../support.ts";
import SandboxApp from "./fixtures/sandbox-app.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

// A team holds one registry, so the app deploys, creates a sandbox per
// request and is destroyed inside one test holding the registry lock.
test.provider.skipIf(skipSlow)(
  "an App creates a sandbox from a template, runs a command, deletes it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { apiKey } = yield* yield* Credentials;
      const ambient = yield* ConfigProvider.ConfigProvider;
      const { url } = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* SandboxApp;
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
      )) as { stdout: string; id: string };
      expect(body.stdout).toEqual("from-the-base");
      // The request's scope deleted the sandbox it created.
      expect(
        yield* isGone(getMicrovm({ microvm_id: body.id })).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (gone) => gone,
            times: 12,
          }),
        ),
      ).toBe(true);
      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:digitalocean", "provider:digitalocean:sandboxes", "live"],
    timeout: 2_700_000,
    exclusive: "digitalocean:registry",
  },
);
