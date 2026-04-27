import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

export default Alchemy.Stack(
  "AlchemyGitHubSecrets",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      GitHub.SecretProvider(),
      GitHub.VariableProvider(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const { accountId } = yield* Cloudflare.CloudflareEnvironment;

    const apiToken = yield* Cloudflare.UserApiToken("ApiToken", {
      name: "alchemy-effect-ci",
      policies: [
        {
          effect: "allow",
          permissionGroups: [
            "Workers Scripts Write",
            "Workers KV Storage Write",
            "Workers R2 Storage Write",
            "D1 Write",
            "Queues Write",
            "Pages Write",
            "Account Settings Write",
            "Workers Tail Read",
          ],
          resources: {
            "com.cloudflare.api.account": "*",
          },
        },
      ],
    });

    yield* Effect.all(
      secrets({
        [`${stage.toUpperCase()}_CLOUDFLARE_API_TOKEN`]: apiToken.value,
        [`${stage.toUpperCase()}_CLOUDFLARE_ACCOUNT_ID`]: accountId,
      }),
    );
  }).pipe(Effect.orDie),
);

const secrets = (
  secrets: Record<string, Alchemy.Input<string | Redacted.Redacted<string>>>,
) =>
  Object.entries(secrets).map(([name, value]) =>
    GitHub.Secret(name, {
      owner: "alchemy-run",
      repository: "alchemy-effect",
      name,
      value: Redacted.make(value),
    }),
  );
