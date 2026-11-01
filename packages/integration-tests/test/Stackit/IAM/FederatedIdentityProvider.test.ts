import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as serviceAccount from "@distilled.cloud/stackit/service_account";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("iam", "federatedidentityprovider"),
  timeout: 180_000,
} as const;

const GITHUB = "https://token.actions.githubusercontent.com";
const AUDIENCE = { item: "aud", value: "sts.accounts.stackit.cloud" } as const;

/** Out-of-band: the provider, or `undefined` once STACKIT reports it missing. */
const getProvider = (projectId: string, serviceAccountEmail: string, federationId: string) =>
  serviceAccount
    .getFederatedIdentityProvider({ projectId, serviceAccountEmail, federationId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const waitUntilGone = (projectId: string, serviceAccountEmail: string, federationId: string) =>
  getProvider(projectId, serviceAccountEmail, federationId).pipe(
    Effect.map((provider) => (provider === undefined ? "gone" : "present")),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const waitUntilAccountGone = (projectId: string, email: string) =>
  serviceAccount.listServiceAccounts({ projectId }).pipe(
    Effect.map((list) =>
      list.items.some((account) => account.email === email) ? "present" : "gone",
    ),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const sortedClaims = (
  assertions: ReadonlyArray<{ item: string; operator: string; value: string }>,
) =>
  assertions
    .map((assertion) => `${assertion.item} ${assertion.operator} ${assertion.value}`)
    .sort();

const federated = (
  props: Omit<Stackit.IAM.FederatedIdentityProviderProps, "serviceAccountEmail">,
) =>
  Effect.gen(function* () {
    const account = yield* Stackit.IAM.ServiceAccount("Federated", {});
    const provider = yield* Stackit.IAM.FederatedIdentityProvider("GitHub", {
      ...props,
      serviceAccountEmail: account.email,
    });
    return { account, provider };
  });

test.provider(
  "create a federated identity provider, update issuer, assertions and name in place, remove it",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const { account, provider } = yield* stack.deploy(
        federated({
          issuer: GITHUB,
          assertions: [
            AUDIENCE,
            { item: "sub", value: "repo:alchemy-run/alchemy:ref:refs/heads/main" },
          ],
        }),
      );

      expect(provider.serviceAccountEmail).toEqual(account.email);
      expect(provider.projectId).toEqual(projectId);
      expect(provider.issuer).toEqual(GITHUB);
      expect(sortedClaims(provider.assertions)).toEqual([
        "aud equals sts.accounts.stackit.cloud",
        "sub equals repo:alchemy-run/alchemy:ref:refs/heads/main",
      ]);

      const observed = yield* getProvider(projectId, account.email, provider.federationId);
      expect(observed?.name).toEqual(provider.name);
      expect(observed?.issuer).toEqual(GITHUB);
      expect(sortedClaims(observed?.assertions ?? [])).toEqual(sortedClaims(provider.assertions));

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(
        federated({
          issuer: GITHUB,
          assertions: [
            AUDIENCE,
            { item: "sub", value: "repo:alchemy-run/alchemy:ref:refs/heads/main" },
          ],
        }),
      );
      expect(plan.resources.GitHub).toMatchObject({ action: "noop" });

      // Issuer, assertions and name all update in place.
      const updated = yield* stack.deploy(
        federated({
          name: "alchemy-test-idp",
          issuer: "https://auth.example.com",
          assertions: [
            { item: "aud", operator: "equals", value: "stackit" },
            { item: "email", operator: "equals", value: "worker@example.com" },
          ],
        }),
      );
      expect(updated.provider.federationId).toEqual(provider.federationId);
      expect(updated.provider.name).toEqual("alchemy-test-idp");
      expect(updated.provider.issuer).toEqual("https://auth.example.com");

      const reobserved = yield* getProvider(projectId, account.email, provider.federationId);
      expect(reobserved?.name).toEqual("alchemy-test-idp");
      expect(reobserved?.issuer).toEqual("https://auth.example.com");
      expect(sortedClaims(reobserved?.assertions ?? [])).toEqual([
        "aud equals stackit",
        "email equals worker@example.com",
      ]);

      // Dropping it from the stack deletes it and keeps the account.
      const remaining = yield* stack.deploy(Stackit.IAM.ServiceAccount("Federated", {}));
      expect(remaining.email).toEqual(account.email);
      expect(yield* waitUntilGone(projectId, account.email, provider.federationId)).toEqual("gone");

      yield* stack.destroy();

      expect(yield* waitUntilAccountGone(projectId, account.email)).toEqual("gone");
    }).pipe(logLevel),
  options,
);

test.provider(
  "moving a federated identity provider to another service account replaces it",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const accounts = Effect.gen(function* () {
        const first = yield* Stackit.IAM.ServiceAccount("First", {});
        const second = yield* Stackit.IAM.ServiceAccount("Second", {});
        return { first, second };
      });
      const deployOn = (which: "first" | "second") =>
        stack.deploy(
          Effect.gen(function* () {
            const { first, second } = yield* accounts;
            const provider = yield* Stackit.IAM.FederatedIdentityProvider("Moved", {
              serviceAccountEmail: (which === "first" ? first : second).email,
              issuer: GITHUB,
              assertions: [AUDIENCE],
            });
            return { first, second, provider };
          }),
        );

      const before = yield* deployOn("first");
      expect(before.provider.serviceAccountEmail).toEqual(before.first.email);
      expect(
        (yield* getProvider(projectId, before.first.email, before.provider.federationId))?.issuer,
      ).toEqual(GITHUB);

      const after = yield* deployOn("second");
      expect(after.provider.serviceAccountEmail).toEqual(after.second.email);
      expect(after.second.email).toEqual(before.second.email);
      expect(
        (yield* getProvider(projectId, after.second.email, after.provider.federationId))?.issuer,
      ).toEqual(GITHUB);
      expect(
        yield* waitUntilGone(projectId, before.first.email, before.provider.federationId),
      ).toEqual("gone");

      yield* stack.destroy();

      expect(yield* waitUntilAccountGone(projectId, before.first.email)).toEqual("gone");
      expect(yield* waitUntilAccountGone(projectId, before.second.email)).toEqual("gone");
    }).pipe(logLevel),
  options,
);
