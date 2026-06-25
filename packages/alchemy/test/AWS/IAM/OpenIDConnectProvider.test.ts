import * as AWS from "@/AWS";
import { OpenIDConnectProvider } from "@/AWS/IAM";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { testOidcListUrl, testOidcThumbprintA } from "./fixtures.ts";

const { test } = Test.make({ providers: AWS.providers() });

describe("AWS.IAM.OpenIDConnectProvider", () => {
  test.provider(
    "list enumerates the deployed OpenID Connect provider",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* OpenIDConnectProvider("ListOidcProvider", {
              url: testOidcListUrl,
              clientIDList: ["sts.amazonaws.com"],
              thumbprintList: [testOidcThumbprintA],
              tags: {
                env: "test",
              },
            });
          }),
        );

        const provider = yield* Provider.findProvider(OpenIDConnectProvider);
        const all = yield* provider.list();

        expect(
          all.some(
            (p) =>
              p.openIDConnectProviderArn === deployed.openIDConnectProviderArn,
          ),
        ).toBe(true);

        const found = all.find(
          (p) =>
            p.openIDConnectProviderArn === deployed.openIDConnectProviderArn,
        );
        expect(found?.url).toBe(testOidcListUrl.replace(/^https?:\/\//, ""));
        expect(found?.clientIDList ?? []).toContain("sts.amazonaws.com");

        yield* stack.destroy();
      }),
  );
});
