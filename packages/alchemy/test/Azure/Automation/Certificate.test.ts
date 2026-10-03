import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as automation from "@distilled.cloud/azure/automation";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  TEST_CERTIFICATE_BASE64,
  TEST_CERTIFICATE_THUMBPRINT,
} from "./fixtures.ts";
import {
  account,
  logLevel,
  subscription,
  tags,
  waitGone,
  sharedAccountTest,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: { name?: string; description?: string }) =>
  Effect.gen(function* () {
    const { where } = yield* account;
    const certificate = yield* Azure.Automation.Certificate("Certificate", {
      ...where,
      name: props.name,
      base64Value: Redacted.make(TEST_CERTIFICATE_BASE64),
      description: props.description,
    });
    return { where, certificate };
  });

const getCertificate = (
  resourceGroupName: string,
  automationAccountName: string,
  certificateName: string,
) =>
  Effect.gen(function* () {
    return yield* automation.GetCertificate({
      subscriptionId: yield* subscription,
      resourceGroupName,
      automationAccountName,
      certificateName,
    });
  });

// Free: an Automation account plus one certificate, seconds to provision.
test.provider(
  "create, update, replace, and delete a certificate",
  (stack) =>
    sharedAccountTest(stack)(
      Effect.gen(function* () {
        yield* stack.destroy();

        const { where, certificate } = yield* stack.deploy(
          program({ description: "one" }),
        );
        const get = (name: string) =>
          getCertificate(where.resourceGroup, where.automationAccount, name);
        expect(certificate.thumbprint?.toUpperCase()).toEqual(
          TEST_CERTIFICATE_THUMBPRINT,
        );
        const observed = yield* get(certificate.certificateName);
        expect(observed.properties?.description).toEqual("one");

        // In-place: description.
        const updated = yield* stack.deploy(program({ description: "two" }));
        expect(updated.certificate.certificateId).toEqual(
          certificate.certificateId,
        );
        expect(
          (yield* get(certificate.certificateName)).properties?.description,
        ).toEqual("two");

        // Replacement: the name is immutable.
        const replaced = yield* stack.deploy(
          program({ name: "alchemy-test-cert-renamed", description: "two" }),
        );
        expect(replaced.certificate.certificateName).toEqual(
          "alchemy-test-cert-renamed",
        );
        expect(yield* waitGone(get(certificate.certificateName))).toEqual(
          "gone",
        );

        yield* stack.destroy();
        expect(
          yield* waitGone(get(replaced.certificate.certificateName)),
        ).toEqual("gone");
      }),
    ).pipe(logLevel),
  { tags, timeout: 600_000 },
);
