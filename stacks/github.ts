import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

export default Alchemy.Stack(
  "AlchemyGitHubSecrets",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const testAccountId = yield* Config.string("TEST_CLOUDFLARE_ACCOUNT_ID");
    const prodAccountId = yield* Config.string("PROD_CLOUDFLARE_ACCOUNT_ID");

    const testApiToken = yield* token("TestApiToken", {
      accountId: testAccountId,
    });

    const prodApiToken = yield* token("ProdApiToken", {
      accountId: prodAccountId,
    });

    yield* secrets({
      TEST_CLOUDFLARE_API_TOKEN: testApiToken.value,
      TEST_CLOUDFLARE_ACCOUNT_ID: testAccountId,
      PROD_CLOUDFLARE_API_TOKEN: prodApiToken.value,
      PROD_CLOUDFLARE_ACCOUNT_ID: prodAccountId,
    });

    return {
      TEST_CLOUDFLARE_API_TOKEN: testApiToken.value.pipe(
        Output.map(Redacted.value),
      ),
      TEST_CLOUDFLARE_ACCOUNT_ID: testAccountId,
      PROD_CLOUDFLARE_API_TOKEN: prodApiToken.value.pipe(
        Output.map(Redacted.value),
      ),
      PROD_CLOUDFLARE_ACCOUNT_ID: prodAccountId,
    };
  }).pipe(Effect.orDie),
);

const token = (
  id: string,
  props: {
    accountId: string;
  },
) =>
  Cloudflare.AccountApiToken(id, {
    accountId: props.accountId,
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
          "Secrets Store Write",
          "Workers Tail Read",
        ],
        resources: {
          [`com.cloudflare.api.account.${props.accountId}`]: "*",
        },
      },
    ],
  });

const secrets = (
  secrets: Record<string, Alchemy.Input<string | Redacted.Redacted<string>>>,
) =>
  Effect.all(
    Object.entries(secrets).map(([name, value]) =>
      GitHub.Secret(name, {
        owner: "alchemy-run",
        repository: "alchemy-effect",
        name,
        value: Redacted.make(value),
      }),
    ),
  );
