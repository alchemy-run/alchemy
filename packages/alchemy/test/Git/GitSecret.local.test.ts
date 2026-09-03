/**
 * The starter's secret: an `Alchemy.Random` declared by the user, bound
 * into the Worker by `AuthenticatedSecret`, and read back from the stack.
 * Presenting it is the principal; anything else is anonymous.
 */
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { makeSecretStack } from "./fixtures/secret-stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const Stack = makeSecretStack("GitSecretLocalStack");
const stack = beforeAll(deploy(Stack));
afterAll(destroy(Stack));

test(
  "the stack reveals the Random; presenting it is the principal, anything else is anonymous",
  Effect.gen(function* () {
    const { url, secret } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);

    const create = (token: string) =>
      client
        .execute(
          HttpClientRequest.post(`${url}/api/v1/repos`).pipe(
            HttpClientRequest.bearerToken(token),
            HttpClientRequest.bodyJsonUnsafe({ owner: "acme", name: "web" }),
          ),
        )
        .pipe(
          Effect.retry({
            schedule: Schedule.exponential("500 millis"),
            times: 10,
          }),
        );

    // An unknown secret is anonymous, and anonymous may not create: the
    // registry-level denial is a typed 403.
    const denied = yield* create("not-the-secret");
    expect(denied.status).toBe(403);

    const created = yield* create(secret);
    expect(created.status).toBe(200);
    const body = (yield* created.json) as { repo: { owner: string } };
    expect(body.repo.owner).toBe("acme");
  }),
  { timeout: 120_000 },
);
