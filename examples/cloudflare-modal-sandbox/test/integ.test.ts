import { expect } from "bun:test";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Modal from "@alchemy.run/modal";
import * as Test from "@alchemy.run/test/Bun";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), Modal.providers()),
  state: Alchemy.localState(),
});

const stack = beforeAll(deploy(Stack));

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "a user's notes live on their volume and a sandbox reads them",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const base = url.replace(/\/+$/, "");

    const ready = yield* Test.getWhenReady(base);
    expect(ready.status).toBe(200);

    const put = yield* HttpClient.execute(
      HttpClientRequest.put(`${base}/notes?user=ada`).pipe(
        HttpClientRequest.bodyText("hello from ada"),
      ),
    );
    expect(put.status).toBe(200);

    const run = yield* HttpClient.execute(HttpClientRequest.get(`${base}/run?user=ada`));
    const result = (yield* run.json) as { exitCode: number; stdout: string };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("package.json");
    expect(result.stdout).toContain("hello from ada");
  }),
  { timeout: 600_000 },
);
