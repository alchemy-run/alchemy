import { expect } from "bun:test";
import * as Azure from "@alchemy.run/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
import * as web from "@distilled.cloud/azure/web";
import * as Alchemy from "alchemy";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Bun";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

/** The deployer's credentials, for out-of-band ARM reads. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

// An S0 AI services account ($0 idle), two GlobalStandard deployments (billed
// per token) and a Flex Consumption app (billed per execution). One run spends
// a few hundred tokens: well under $0.01, so the test is not gated.
const stack = beforeAll(deploy(Stack), { timeout: 1_200_000 });

class NotOk extends Data.TaggedError("NotOk")<{ readonly status: number; readonly body: string }> {}

const baseUrl = Effect.map(stack, ({ url }) => String(url).replace(/\/+$/, ""));

/**
 * POST to the API until it answers `expected`. Retries through the Flex
 * Consumption cold start and the role assignments propagating after the
 * first deploy (the API answers 503 until then, about 4 minutes at most).
 */
const post = <T>(path: string, body: unknown, expected: number) =>
  Effect.flatMap(baseUrl, (base) =>
    Effect.gen(function* () {
      const res = yield* HttpClient.execute(
        HttpClientRequest.post(`${base}${path}`).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
      );
      const text = yield* res.text;
      if (res.status !== expected) return yield* new NotOk({ status: res.status, body: text });
      return JSON.parse(text) as T;
    }).pipe(
      Effect.timeout("60 seconds"),
      Effect.tapError((error) => Effect.logWarning(error)),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 60 }),
    ),
  );

/** Where the example's resources are, from the stack outputs. */
const where = Effect.gen(function* () {
  const outputs = yield* stack;
  const { subscriptionId } = yield* Azure.AzureEnvironment.current.pipe(Effect.provide(azure));
  return { subscriptionId, resourceGroupName: outputs.resourceGroup, outputs };
});

type Where = Effect.Success<typeof where>;

const deploymentOf = ({ subscriptionId, resourceGroupName, outputs }: Where, name: string) =>
  cognitiveservices
    .GetDeployment({
      subscriptionId,
      resourceGroupName,
      accountName: outputs.accountName,
      deploymentName: name,
    })
    .pipe(
      Effect.map((deployment) => ({
        model: deployment.properties?.model?.name,
        sku: deployment.sku?.name,
        state: deployment.properties?.provisioningState,
      })),
      Effect.provide(azure),
    );

/** Data actions of every role the Function's identity holds on the account. */
const dataActionsOnAccount = ({ subscriptionId, outputs }: Where) =>
  Effect.gen(function* () {
    const assignments = yield* Stream.runCollect(
      authorization.ListRoleAssignmentForSubscription.items({
        subscriptionId,
        _filter: `principalId eq '${outputs.principalId}'`,
      }),
    );
    const actions: string[] = [];
    for (const assignment of assignments) {
      if (assignment.properties?.scope?.toLowerCase() !== outputs.accountId.toLowerCase()) continue;
      const definition = yield* authorization.GetRoleDefinition({
        scope: `/subscriptions/${subscriptionId}`,
        roleDefinitionId: assignment.properties?.roleDefinitionId?.split("/").pop() ?? "",
      });
      for (const permission of definition.properties?.permissions ?? []) {
        actions.push(...(permission.actions ?? []), ...(permission.dataActions ?? []));
      }
    }
    return actions.sort();
  }).pipe(
    // Role-assignment lists trail writes by a few seconds.
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (actions) => actions.length >= 2,
      times: 12,
    }),
    Effect.provide(azure),
  );

const accountStatus = ({ subscriptionId, resourceGroupName, outputs }: Where) =>
  cognitiveservices
    .GetAccount({ subscriptionId, resourceGroupName, accountName: outputs.accountName })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
        Effect.succeed("gone" as const),
      ),
      Effect.provide(azure),
    );

/** A deleted account stays soft-deleted for 48 hours unless it is purged. */
const deletedAccountStatus = ({ subscriptionId, resourceGroupName, outputs }: Where) =>
  cognitiveservices
    .GetDeletedAccount({
      subscriptionId,
      location: outputs.location,
      resourceGroupName,
      accountName: outputs.accountName,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound", "NotFound"], () =>
        Effect.succeed("gone" as const),
      ),
      Effect.provide(azure),
    );

const appStatus = ({ subscriptionId, resourceGroupName, outputs }: Where) =>
  web.GetWebApp({ subscriptionId, resourceGroupName, name: outputs.functionAppName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.provide(azure),
  );

/** Poll until a deleted resource reads as gone. */
const untilGone = <E, R>(status: Effect.Effect<"found" | "gone", E, R>) =>
  status.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (current) => current === "gone",
      times: 24,
    }),
  );

afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const deployed = yield* stack;
    yield* destroy(Stack);
    // A failed deploy has no outputs to check against.
    if (deployed === undefined) return;
    const ids = yield* where;
    expect(yield* untilGone(accountStatus(ids))).toBe("gone");
    expect(yield* untilGone(deletedAccountStatus(ids))).toBe("gone");
    expect(yield* untilGone(appStatus(ids))).toBe("gone");
  }),
  { timeout: 900_000 },
);

test(
  "deploys both models on the account",
  Effect.gen(function* () {
    const ids = yield* where;
    expect(yield* deploymentOf(ids, ids.outputs.chatDeployment)).toEqual({
      model: "gpt-4.1-mini",
      sku: "GlobalStandard",
      state: "Succeeded",
    });
    expect(yield* deploymentOf(ids, ids.outputs.embeddingDeployment)).toEqual({
      model: "text-embedding-3-small",
      sku: "GlobalStandard",
      state: "Succeeded",
    });
  }),
  { timeout: 120_000 },
);

test(
  "grants the Function's identity one data action per binding, on the account only",
  Effect.gen(function* () {
    const ids = yield* where;
    expect(yield* dataActionsOnAccount(ids)).toEqual([
      "Microsoft.CognitiveServices/accounts/OpenAI/deployments/chat/completions/action",
      "Microsoft.CognitiveServices/accounts/OpenAI/deployments/embeddings/action",
    ]);
  }),
  { timeout: 180_000 },
);

test(
  "POST /chat answers with gpt-4.1-mini",
  Effect.gen(function* () {
    const reply = yield* post<{
      text: string;
      model: string;
      finishReason: string;
      usage: { inputTokens: number; outputTokens: number };
    }>("/chat", { prompt: "Reply with exactly the word: pong" }, 200);
    expect(reply.text.toLowerCase()).toContain("pong");
    expect(reply.model).toContain("gpt-4.1-mini");
    expect(reply.finishReason).toBe("stop");
    expect(reply.usage.inputTokens).toBeGreaterThan(0);
    expect(reply.usage.outputTokens).toBeGreaterThan(0);
  }),
  { timeout: 600_000 },
);

test(
  "POST /embed embeds each input with text-embedding-3-small",
  Effect.gen(function* () {
    const result = yield* post<{ model: string; count: number; dimensions: number }>(
      "/embed",
      { input: ["hello", "world"] },
      200,
    );
    expect(result).toEqual({ model: "text-embedding-3-small", count: 2, dimensions: 1536 });
  }),
  { timeout: 600_000 },
);

test(
  "POST /chat rejects a request without a prompt",
  Effect.gen(function* () {
    const reply = yield* post<{ error: string }>("/chat", {}, 400);
    expect(reply.error).toBe("expected { prompt: string, system?: string }");
  }),
  { timeout: 300_000 },
);
