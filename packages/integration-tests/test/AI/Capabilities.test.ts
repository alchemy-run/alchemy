import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import Guarded from "./fixtures/Guarded.ts";

const providers = Cloudflare.providers();

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers });

const Stack = Alchemy.Stack(
  "CapabilitiesStack",
  { providers, state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* Guarded;
    return { url: worker.url.as<string>() };
  }),
);

const stack = beforeAll(deploy(Stack), { timeout: 300_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const call = Effect.fn(function* (path: string) {
  const { url } = yield* stack;
  const client = yield* HttpClient.HttpClient;
  const response = yield* HttpClient.filterStatusOk(client)
    .get(`${url}/${path}`)
    .pipe(Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 8 }));
  return (yield* response.json) as {
    readonly ok?: { readonly saved?: boolean; readonly text?: string };
    readonly failed?: { readonly _tag?: string; readonly message?: string };
  };
});

test(
  "a deployed tool uses the binding its Layer bound, and no client it only closed over",
  Effect.gen(function* () {
    // `save` bound the namespace where it was built: the plan lists it there.
    expect(yield* call("save?key=greeting&text=hello")).toEqual({ ok: { saved: true } });
    // So did `recall`, declared with its implementation, in the Effect that builds it.
    expect(yield* call("recall?key=greeting")).toEqual({ ok: { text: "hello" } });
    // The Worker bound it too, and reads it outside any tool.
    expect(yield* call("direct?key=greeting")).toEqual({ ok: { text: "hello" } });
    // `leak` was handed the Worker's client. The plan lists nothing under it.
    expect(yield* call("leak?key=greeting")).toEqual({
      failed: {
        _tag: "CapabilityDenied",
        message:
          "Tool leak used Cloudflare.KVNamespace.ReadWrite on Cloudflare.KV.Namespace(GuardedNotes), which the plan does not list under it. Bind it where the tool is built.",
      },
    });
  }),
  { timeout: 180_000, tags: ["provider:cloudflare", "provider:cloudflare:kv", "live"] },
);
