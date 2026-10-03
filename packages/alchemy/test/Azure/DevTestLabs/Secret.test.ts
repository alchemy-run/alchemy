import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  labUserFixture,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSecret = (
  resourceGroupName: string,
  labName: string,
  userName: string,
  name: string,
) =>
  Effect.gen(function* () {
    return yield* devtestlabs.GetSecret({
      subscriptionId: yield* subscription,
      resourceGroupName,
      labName,
      userName,
      name,
      _expand: "properties($select=value)",
    });
  });

const program = (props: { value: string }) =>
  Effect.gen(function* () {
    const { group, lab, user } = yield* labUserFixture();
    const secret = yield* Azure.DevTestLabs.Secret("Token", {
      resourceGroup: group.resourceGroupName,
      lab: lab.labName,
      user: user.userName,
      value: Redacted.make(props.value),
    });
    return { group, lab, user, secret };
  });

// Free lab + user + Key Vault secret; ~5 minutes for the lab.
test.provider(
  "create, rotate, and delete a lab secret",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, lab, user, secret } = yield* stack.deploy(
        program({ value: "first-value" }),
      );
      const get = () =>
        getSecret(
          group.resourceGroupName,
          lab.labName,
          user.userName,
          secret.secretName,
        );
      const observed = yield* get();
      expect(observed.name).toEqual(secret.secretName);
      expect(observed.id?.toLowerCase()).toEqual(secret.secretId.toLowerCase());

      // In-place: rotate the value.
      const updated = yield* stack.deploy(
        program({ value: "second-value" }),
      );
      expect(updated.secret.secretId).toEqual(secret.secretId);
      const reobserved = yield* get();
      expect(reobserved.name).toEqual(secret.secretName);
      if (reobserved.properties?.value !== undefined) {
        expect(reobserved.properties.value).toEqual("second-value");
      }

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
