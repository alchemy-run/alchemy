import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as ses from "@distilled.cloud/aws/sesv2";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { testName } from "../../names.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:ses", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "SesConfigurationLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const configSet = yield* AWS.SES.ConfigurationSet("lookup-target-config");
    const list = yield* AWS.SES.ContactList("lookup-target-list");
    const template = yield* AWS.SES.EmailTemplate("lookup-target-template", {
      subject: "Lookup",
      text: "Looked up.",
    });
    const identity = yield* AWS.SES.EmailIdentity("lookup-target-identity", {
      emailIdentity: `${testName("alchemy-lookup")}.example.com`,
    });
    return {
      configurationSetName: configSet.configurationSetName.as<string>(),
      configurationSetArn: configSet.configurationSetArn.as<string>(),
      contactListName: list.contactListName.as<string>(),
      contactListArn: list.contactListArn.as<string>(),
      templateName: template.templateName.as<string>(),
      templateArn: template.templateArn.as<string>(),
      emailIdentity: identity.emailIdentity.as<string>(),
      identityArn: identity.identityArn.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "configuration sets, contact lists, templates and identities resolve by name, and survive destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const {
        configurationSetName,
        configurationSetArn,
        contactListName,
        contactListArn,
        templateName,
        templateArn,
        emailIdentity,
        identityArn,
      } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          return {
            configSet: AWS.SES.ConfigurationSet.lookup({ configurationSetName })
              .configurationSetArn,
            list: AWS.SES.ContactList.lookup({ contactListName }).contactListArn,
            template: AWS.SES.EmailTemplate.lookup({ templateName }).templateArn,
            identity: AWS.SES.EmailIdentity.lookup({ emailIdentity }).identityArn,
          };
        },
        {
          configSet: configurationSetArn,
          list: contactListArn,
          template: templateArn,
          identity: identityArn,
        },
      );
      const survivor = yield* ses.getConfigurationSet({
        ConfigurationSetName: configurationSetName,
      });
      expect(survivor.ConfigurationSetName).toBe(configurationSetName);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing configuration set, template or identity fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const lookups = {
        "missing-config": AWS.SES.ConfigurationSet.lookup({ configurationSetName: name })
          .configurationSetArn,
        "missing-template": AWS.SES.EmailTemplate.lookup({ templateName: name }).templateArn,
        "missing-identity": AWS.SES.EmailIdentity.lookup({ emailIdentity: `${name}.example.com` })
          .identityArn,
      };
      for (const [id, value] of Object.entries(lookups)) {
        yield* expectDeployFails(stack.deploy(AWS.SSM.Parameter(id, { value })), [
          "LookupNotFoundError",
        ]);
      }
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a configuration set this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => AWS.SES.ConfigurationSet("lookup-managed");
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-configuration-set-consumer", {
              value: AWS.SES.ConfigurationSet.lookup({
                configurationSetName: attrs.configurationSetName,
              }).configurationSetArn,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
