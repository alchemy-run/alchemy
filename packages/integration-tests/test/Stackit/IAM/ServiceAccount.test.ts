import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as serviceAccount from "@distilled.cloud/stackit/service_account";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("iam", "serviceaccount"), timeout: 180_000 } as const;

/** Out-of-band: the project's service account with this email, if any. */
const findAccount = (projectId: string, email: string) =>
  serviceAccount
    .listServiceAccounts({ projectId })
    .pipe(Effect.map((list) => list.items.find((account) => account.email === email)));

/** Poll (bounded) until the account no longer exists. */
const waitUntilGone = (projectId: string, email: string) =>
  findAccount(projectId, email).pipe(
    Effect.map((account) => (account === undefined ? "gone" : "present")),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create a service account with a generated name, redeploy as a no-op, destroy",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const account = yield* stack.deploy(Stackit.IAM.ServiceAccount("Generated", {}));

      expect(account.projectId).toEqual(projectId);
      expect(account.name).toMatch(/^gen-[a-z2-7]{16}$/);
      expect(account.email.startsWith(`${account.name}-`)).toEqual(true);
      expect(account.email.endsWith("@sa.stackit.cloud")).toEqual(true);
      expect(account.internal).toEqual(false);
      expect(Stackit.IAM.serviceAccountNameOf(account.email)).toEqual(account.name);

      const observed = yield* findAccount(projectId, account.email);
      expect(observed?.id).toEqual(account.id);
      expect(observed?.projectId).toEqual(projectId);

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(Stackit.IAM.ServiceAccount("Generated", {}));
      expect(plan.resources.Generated).toMatchObject({ action: "noop" });

      const again = yield* stack.deploy(Stackit.IAM.ServiceAccount("Generated", {}));
      expect(again.email).toEqual(account.email);
      expect(again.id).toEqual(account.id);

      yield* stack.destroy();

      expect(yield* waitUntilGone(projectId, account.email)).toEqual("gone");
    }).pipe(logLevel),
  options,
);

test.provider(
  "renaming a service account replaces it and deletes the old one",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Stackit.IAM.ServiceAccount("Renamed", { name: "alc-sa-rename-a" }),
      );
      expect(first.name).toEqual("alc-sa-rename-a");
      expect(first.email.startsWith("alc-sa-rename-a-")).toEqual(true);
      expect((yield* findAccount(projectId, first.email))?.id).toEqual(first.id);

      const plan = yield* stack.plan(
        Stackit.IAM.ServiceAccount("Renamed", { name: "alc-sa-rename-b" }),
      );
      expect(plan.resources.Renamed).toMatchObject({ action: "replace" });

      const second = yield* stack.deploy(
        Stackit.IAM.ServiceAccount("Renamed", { name: "alc-sa-rename-b" }),
      );
      expect(second.name).toEqual("alc-sa-rename-b");
      expect(second.email).not.toEqual(first.email);
      expect(second.id).not.toEqual(first.id);
      expect((yield* findAccount(projectId, second.email))?.id).toEqual(second.id);
      expect(yield* waitUntilGone(projectId, first.email)).toEqual("gone");

      yield* stack.destroy();

      expect(yield* waitUntilGone(projectId, second.email)).toEqual("gone");
    }).pipe(logLevel),
  options,
);

test.provider(
  "list enumerates a service account with a generated name",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const account = yield* stack.deploy(Stackit.IAM.ServiceAccount("Listed", {}));

      const provider = yield* Provider.findProvider(Stackit.IAM.ServiceAccount);
      const all = yield* provider.list();
      const found = all.find((item) => item.email === account.email);
      // `list` recognizes a generated name by its instance-id tail, which must
      // hold a base32 digit (2-7); the few tails without one are skipped on
      // purpose (nuke under-reports rather than over-deletes).
      const recognizable = /[2-7]/.test(account.name.slice(-16));
      expect(found?.id).toEqual(recognizable ? account.id : undefined);
      expect(found?.name).toEqual(recognizable ? account.name : undefined);

      yield* stack.destroy();

      expect(yield* waitUntilGone(projectId, account.email)).toEqual("gone");
    }).pipe(logLevel),
  options,
);
