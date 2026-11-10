import * as Modal from "@alchemy.run/modal";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as service from "@distilled.cloud/modal/service";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: Modal.providers() });

// Service users need Modal's Team or Enterprise plan. A Starter workspace
// gets `Modal.ServiceUsersNotAvailable`; set MODAL_TEST_SERVICE_USERS=1 on a
// Team workspace to run the lifecycle instead.
const entitled = !!process.env.MODAL_TEST_SERVICE_USERS;

test.provider.skipIf(entitled)(
  "a Starter workspace gets ServiceUsersNotAvailable naming DeployerHostIdentity",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const error = yield* stack.deploy(Modal.ServiceUser("Probe", {})).pipe(Effect.flip);
      const failure = error as { readonly _tag?: string; readonly message?: string };
      expect(failure._tag).toBe("Modal.ServiceUsersNotAvailable");
      expect(failure.message).toContain("Modal.DeployerHostIdentity");
      yield* stack.destroy();
    }),
  { tags: ["provider:modal", "provider:modal:service", "live"], timeout: 120_000 },
);

const deployUser = (role: "viewer" | "contributor") =>
  Effect.gen(function* () {
    const environment = yield* Modal.Environment("ServiceUserEnv", {});
    return yield* Modal.ServiceUser("Deployer", { environments: [{ environment, role }] });
  });

const rolesOf = (name: string) =>
  service
    .serviceUserInfo({ serviceUserName: name })
    .pipe(
      Effect.map((info) =>
        Object.fromEntries(
          (info.serviceUser?.environmentRoles ?? []).map((entry) => [
            entry.environmentName ?? "",
            entry.role,
          ]),
        ),
      ),
    );

test.provider.skipIf(!entitled)(
  "create a scoped service user, change its role, and delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(deployUser("contributor"));
      expect(created.scoped).toBe(true);
      expect(created.tokenId).toMatch(/^ak-/);
      expect(Redacted.value(created.tokenSecret)).toMatch(/^as-/);
      const [envName] = Object.keys(created.environments);
      expect((yield* rolesOf(created.name))[envName!]).toBe("ENVIRONMENT_ROLE_CONTRIBUTOR");

      const updated = yield* stack.deploy(deployUser("viewer"));
      expect(updated.serviceUserId).toBe(created.serviceUserId);
      expect(updated.tokenId).toBe(created.tokenId);
      expect((yield* rolesOf(updated.name))[envName!]).toBe("ENVIRONMENT_ROLE_VIEWER");

      yield* stack.destroy();
      const gone = yield* service
        .serviceUserInfo({ serviceUserName: created.name })
        .pipe(Effect.catchTag("ServiceUserNotFound", () => Effect.succeed(undefined)));
      expect(gone?.serviceUser?.serviceUserId).toBeUndefined();
    }),
  { tags: ["provider:modal", "provider:modal:service-user", "live"], timeout: 120_000 },
);
