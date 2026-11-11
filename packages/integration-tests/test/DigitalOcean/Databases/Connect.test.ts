import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import { logLevel, skipSlow } from "../support.ts";
import ConnectApp from "./fixtures/connect-app.ts";

const { beforeAll, afterAll, deploy, destroy, test } = Test.make({
  providers: DigitalOcean.providers(),
});

const Stack = Alchemy.Stack(
  "DigitalOceanDatabaseConnect",
  { providers: DigitalOcean.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const app = yield* ConnectApp;
    return { url: app.url };
  }),
);

// A cluster and an app build each take several minutes.
const stack = beforeAll(skipSlow ? Effect.succeed({ url: "" }) : deploy(Stack), {
  timeout: 2_400_000,
  exclusive: "digitalocean:registry",
});
afterAll.skipIf(skipSlow || !!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 1_200_000,
  exclusive: "digitalocean:registry",
});

test.skipIf(skipSlow)(
  "an App queries Postgres with the connection string Connect binds",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    const body = yield* client.get(url).pipe(
      Effect.flatMap((response) => response.json),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
    );
    expect(body).toEqual({ answer: 42 });
  }).pipe(logLevel),
  {
    tags: ["provider:digitalocean", "provider:digitalocean:databases", "live"],
    timeout: 300_000,
  },
);
