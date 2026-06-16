import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

test.provider("list enumerates the deployed infrastructure target", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const target = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.AccessInfrastructureTarget("ListTarget", {
          hostname: "list-test.bastion.internal",
          ip: { ipv4: { ipAddr: "10.7.0.42" } },
        });
      }),
    );

    const provider = yield* Provider.findProvider(
      Cloudflare.AccessInfrastructureTarget,
    );
    const all = yield* provider.list();

    const found = all.find((t) => t.targetId === target.targetId);
    expect(found).toBeDefined();
    expect(found?.accountId).toEqual(accountId);
    expect(found?.hostname).toEqual(target.hostname);
    expect(found?.ip.ipv4?.ipAddr).toEqual("10.7.0.42");

    yield* stack.destroy();
  }),
);
