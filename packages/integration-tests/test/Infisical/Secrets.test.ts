import * as Infisical from "@alchemy.run/infisical";
import { describe, expect, it } from "@alchemy.run/test";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import { inMemoryState } from "alchemy/State";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";

const projectId = "6f1c0b52-6a8f-4f3e-9a51-0d6c1a2f7e10";

interface StoredSecret {
  readonly key: string;
  readonly value: string;
  readonly type: "shared" | "personal";
}

/** The `dev` environment, in which the signed-in user overrides DEVELOPER_NAME. */
const dev: ReadonlyArray<StoredSecret> = [
  { key: "DEVELOPER_NAME", value: "shared", type: "shared" },
  { key: "DEVELOPER_NAME", value: "jason", type: "personal" },
  { key: "REGION", value: "us-east", type: "shared" },
];

/**
 * Infisical's v4 list endpoint, read by that user. Without
 * `includePersonalOverrides` it drops personal secrets. With it, it keeps
 * one secret per key, the personal one when there is one (`getSecretsRaw`
 * in Infisical's `secret-v2-bridge-service.ts`).
 */
const infisical = HttpClient.make((request) =>
  Effect.sync(() => {
    const overrides = new URL(request.url).searchParams.get("includePersonalOverrides") === "true";
    const listed = new Map<string, StoredSecret>();
    for (const secret of dev) {
      if (secret.type === "personal" && !overrides) continue;
      if (!listed.has(secret.key) || secret.type === "personal") listed.set(secret.key, secret);
    }
    return HttpClientResponse.fromWeb(
      request,
      Response.json({
        secrets: [...listed.values()].map((secret) => ({
          id: `${secret.key}-${secret.type}`,
          _id: `${secret.key}-${secret.type}`,
          workspace: projectId,
          environment: "dev",
          version: 1,
          type: secret.type,
          secretKey: secret.key,
          secretValue: secret.value,
          secretComment: "",
          secretValueHidden: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        })),
        imports: [],
      }),
    );
  }),
);

/** Run with `INFISICAL_TOKEN` set in the process environment, which is where the provider reads it. */
const withToken = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.INFISICAL_TOKEN;
      process.env.INFISICAL_TOKEN = "user-token";
      return previous;
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.INFISICAL_TOKEN;
        else process.env.INFISICAL_TOKEN = previous;
      }),
  );

describe("Infisical.Secrets", { tags: ["unit", "provider:infisical"] }, () => {
  it.effect(
    "a user's personal override replaces the shared value",
    () =>
      Effect.gen(function* () {
        const stack = yield* Stack(
          "InfisicalSecrets",
          {
            providers: Layer.empty,
            state: inMemoryState(),
            secrets: [Infisical.Secrets({ project: projectId, environment: "dev" })],
          },
          Effect.all({
            developer: Config.String("DEVELOPER_NAME"),
            region: Config.String("REGION"),
          }),
        );
        expect(stack.output).toEqual({ developer: "jason", region: "us-east" });
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, infisical),
        Effect.provideService(AlchemyContext, {
          dotAlchemy: ".alchemy",
          dev: false,
          adopt: false,
        }),
        Effect.provideService(Stage, "test"),
        withToken,
      ),
    // INFISICAL_TOKEN is process-global.
    { exclusive: true },
  );
});
