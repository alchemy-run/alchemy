import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Modal from "@alchemy.run/modal";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import RuntimeFunction from "./fixtures/runtime-function.ts";
import { hostIdentity } from "./hostIdentity.ts";

const providers = Layer.mergeAll(
  Modal.providers(),
  AWS.providers(),
  Cloudflare.providers(),
  hostIdentity,
);
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers });

const Stack = Alchemy.Stack(
  "ModalRuntimeStack",
  { providers, state: AWS.state() },
  Effect.gen(function* () {
    const host = yield* RuntimeFunction;
    return { url: host.functionUrl.as<string>() };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const get = <A>(path: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const res = yield* client
      .get(`${url}${path}`)
      .pipe(Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 8 }));
    return (yield* res.json) as A;
  });

const tags = ["provider:modal", "provider:modal:sandbox", "provider:aws", "live"];

test(
  "an Effect program runs in a sandbox and uses its bindings",
  Effect.gen(function* () {
    const body = yield* get<{ agent: string; files: number }>("/effect");
    expect(body.agent).toBe("effect");
    expect(typeof body.files).toBe("number");
  }),
  { tags, timeout: 600_000 },
);

test(
  "an async program runs in a sandbox with its env",
  Effect.gen(function* () {
    const body = yield* get<{ agent: string; greeting: string }>("/async");
    expect(body).toEqual({ agent: "async", greeting: "hello from async" });
  }),
  { tags, timeout: 600_000 },
);

test(
  "a program mounts a volume (MountVolume) and a Cloudflare R2 bucket (mounts)",
  Effect.gen(function* () {
    const body = yield* get<{ volume: string; bucket: string }>("/mounts?key=m1");
    expect(body).toEqual({ volume: "volume m1", bucket: "bucket m1" });
  }),
  { tags: [...tags, "provider:cloudflare"], timeout: 600_000 },
);
