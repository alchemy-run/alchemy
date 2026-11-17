import * as Cloudflare from "@alchemy.run/cloudflare";
import * as E2B from "@alchemy.run/e2b";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type { Served } from "./conformance/app.ts";
import { expectGatewayed } from "./conformance/conformance.ts";
import GatewayedContainerLive from "./fixtures/container/container.ts";
import ContainerHost from "./fixtures/container/host.ts";

const providers = Layer.mergeAll(Cloudflare.providers(), E2B.providers());
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers });

// The deploy builds and pushes the container's image.
const HOOK_TIMEOUT = 600_000;

const Stack = Alchemy.Stack(
  "GatewayContainerStack",
  { providers, state: Cloudflare.state() },
  Effect.gen(function* () {
    const host = yield* ContainerHost;
    return { url: host.url.as<string>() };
  }).pipe(Effect.provide(GatewayedContainerLive)),
);

const stack = beforeAll(deploy(Stack), { timeout: HOOK_TIMEOUT });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: HOOK_TIMEOUT });

test(
  "a Cloudflare Container's bindings run in its gateway",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    const served = yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? res.json
          : Effect.flatMap(res.text, (text) => Effect.fail(new Error(`${res.status}: ${text}`))),
      ),
      // A container's first start pulls its image.
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 30 }),
    );
    expectGatewayed(served as unknown as Served, { gatewayHost: "workers.dev" });
  }),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:container",
      "provider:cloudflare:worker",
      "provider:e2b",
      "live",
    ],
    timeout: 600_000,
  },
);
