import * as AWS from "@/AWS";
import { LaunchTemplate } from "@/AWS/AutoScaling";
import { amazonLinux2023 } from "@/AWS/EC2";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// `list()` enumerates every launch template in the account/region via the
// paginated `ec2.describeLaunchTemplates` op. Deploy a real launch template,
// resolve the provider from context via the typed `findProvider`, call
// `list()`, and assert the deployed template appears in the exhaustively
// paginated result.
//
// SKIP GATE (remove once distilled is patched): the deploy/destroy flow drives
// the provider's `read`, which calls `ec2.describeLaunchTemplates` by name. When
// the template does not yet exist (greenfield) or was already deleted (residual
// state), EC2 returns error code `InvalidLaunchTemplateName.NotFoundException`,
// but distilled's `describeLaunchTemplates` error union omits it, so it surfaces
// as the catch-all `UnknownAwsError` and the provider's not-found handling
// cannot catch it. Exact observed failure:
//   _tag: "UnknownAwsError"
//   errorTag: "InvalidLaunchTemplateName.NotFoundException"
//   operation: "DescribeLaunchTemplates"
//   message: "At least one of the launch templates specified in the request does not exist."
// Needed distilled patch: distilled/packages/aws service `ec2`, operation
// `describeLaunchTemplates` — add `InvalidLaunchTemplateName.NotFoundException`
// and `InvalidLaunchTemplateId.NotFound` to its error union (then the provider
// can catch them typed). Run this test by setting
// ALCHEMY_TEST_LAUNCH_TEMPLATE_LIST=1 once the patch lands.
test.provider.skipIf(!process.env.ALCHEMY_TEST_LAUNCH_TEMPLATE_LIST)(
  "list enumerates the deployed launch template",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Launch templates do not validate the AMI at creation time; fall back to a
      // syntactically valid id if the lookup returns nothing.
      const imageId = (yield* amazonLinux2023()) ?? "ami-00000000000000000";

      const template = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* LaunchTemplate("ListLaunchTemplate", {
            launchTemplateName: "alchemy-test-lt-list",
            imageId,
            instanceType: "t3.micro",
          });
        }),
      );

      const provider = yield* Provider.findProvider(LaunchTemplate);
      const all = yield* provider.list();

      expect(
        all.some((t) => t.launchTemplateId === template.launchTemplateId),
      ).toBe(true);

      yield* stack.destroy();
    }),
);
