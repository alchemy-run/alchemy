import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as automation from "@distilled.cloud/azure/automation";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  account,
  logLevel,
  subscription,
  tags,
  waitGone,
  withSharedAccount,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  name?: string;
  userName: string;
  password: string;
  description?: string;
}) =>
  Effect.gen(function* () {
    const { where } = yield* account;
    const credential = yield* Azure.Automation.Credential("Credential", {
      ...where,
      name: props.name,
      userName: props.userName,
      password: Redacted.make(props.password),
      description: props.description,
    });
    return { where, credential };
  });

const getCredential = (
  resourceGroupName: string,
  automationAccountName: string,
  credentialName: string,
) =>
  Effect.gen(function* () {
    return yield* automation.GetCredential({
      subscriptionId: yield* subscription,
      resourceGroupName,
      automationAccountName,
      credentialName,
    });
  });

// Free: an Automation account plus one credential, seconds to provision.
test.provider(
  "create, update, replace, and delete a credential",
  (stack) =>
    withSharedAccount(
      Effect.gen(function* () {
        yield* stack.destroy();

        const { where, credential } = yield* stack.deploy(
          program({ userName: "alice", password: "pw-1" }),
        );
        const get = (name: string) =>
          getCredential(where.resourceGroup, where.automationAccount, name);
        const observed = yield* get(credential.credentialName);
        expect(observed.properties?.userName).toEqual("alice");

        // In-place: user name, password rotation, description.
        const updated = yield* stack.deploy(
          program({ userName: "bob", password: "pw-2", description: "rotated" }),
        );
        expect(updated.credential.credentialId).toEqual(
          credential.credentialId,
        );
        const reobserved = yield* get(credential.credentialName);
        expect(reobserved.properties?.userName).toEqual("bob");
        expect(reobserved.properties?.description).toEqual("rotated");

        // Replacement: the name is immutable.
        const replaced = yield* stack.deploy(
          program({
            name: "alchemy-test-credential-renamed",
            userName: "bob",
            password: "pw-2",
          }),
        );
        expect(replaced.credential.credentialName).toEqual(
          "alchemy-test-credential-renamed",
        );
        expect(yield* waitGone(get(credential.credentialName))).toEqual("gone");

        yield* stack.destroy();
        expect(
          yield* waitGone(get(replaced.credential.credentialName)),
        ).toEqual("gone");
      }),
    ).pipe(logLevel),
  { tags, timeout: 600_000 },
);
