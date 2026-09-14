import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("create and delete basic allow policy", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const policy = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Access.Policy("BasicAllowPolicy", {
          decision: "allow",
          include: [{ emailDomain: { domain: "example.com" } }],
        });
      }),
    );

    expect(policy.policyId).toBeDefined();
    expect(policy.decision).toEqual("allow");
    expect(policy.accountId).toEqual(accountId);

    const actual = yield* zeroTrust.getAccessPolicy({
      accountId,
      policyId: policy.policyId,
    });
    expect(actual.id).toEqual(policy.policyId);
    expect(actual.decision).toEqual("allow");
    expect(actual.include?.length).toEqual(1);

    yield* stack.destroy();

    const afterDestroy = yield* zeroTrust.listAccessPolicies
      .items({ accountId })
      .pipe(Stream.runCollect);
    expect(afterDestroy.some((item) => item.id === policy.policyId)).toBe(
      false,
    );
  }).pipe(logLevel),
);

test.provider("update mutates includes without replacing", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Access.Policy("UpdatePolicy", {
          decision: "allow",
          include: [{ emailDomain: { domain: "example.com" } }],
          adopt: true,
        });
      }),
    );

    expect(initial.policyId).toBeDefined();

    const updated = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Access.Policy("UpdatePolicy", {
          decision: "allow",
          include: [
            { emailDomain: { domain: "example.com" } },
            { emailDomain: { domain: "test.example.com" } },
          ],
          adopt: true,
        });
      }),
    );

    expect(updated.policyId).toEqual(initial.policyId);

    const actual = yield* zeroTrust.getAccessPolicy({
      accountId,
      policyId: updated.policyId,
    });
    expect(actual.include?.length).toEqual(2);

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider("adopts an out-of-band reusable policy", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const name = "alchemy-access-policy-adopt-test";

    yield* stack.destroy();

    // Pre-create the policy out of band so adoption has something to find.
    const preExisting = yield* zeroTrust.createAccessPolicy({
      accountId,
      name,
      decision: "allow",
      include: [{ emailDomain: { domain: "example.com" } }],
    });
    expect(preExisting.id).toBeDefined();

    const adopted = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Access.Policy("AdoptPolicy", {
          name,
          decision: "allow",
          include: [{ emailDomain: { domain: "example.com" } }],
          adopt: true,
        });
      }),
    );

    expect(adopted.policyId).toEqual(preExisting.id);
    expect(adopted.accountId).toEqual(accountId);

    yield* stack.destroy();

    const afterDestroy = yield* zeroTrust.listAccessPolicies
      .items({ accountId })
      .pipe(Stream.runCollect);
    expect(afterDestroy.some((item) => item.id === preExisting.id)).toBe(false);
  }).pipe(logLevel),
);

test.provider("list enumerates the deployed reusable policy", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const policy = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Access.Policy("ListPolicy", {
          decision: "allow",
          include: [{ emailDomain: { domain: "example.com" } }],
        });
      }),
    );

    const provider = yield* Provider.findProvider(Cloudflare.Access.Policy);
    const all = yield* provider.list();

    const match = all.find((p) => p.policyId === policy.policyId);
    expect(match).toBeDefined();
    expect(match?.accountId).toEqual(accountId);
    expect(match?.decision).toEqual("allow");

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider(
  "updates purpose prompts and recovers after an out-of-band deletion",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();
      const fixture = (prompt: string) =>
        Cloudflare.Access.Policy("PurposePolicy", {
          decision: "allow",
          include: [{ emailDomain: { domain: "example.com" } }],
          purposeJustificationRequired: true,
          purposeJustificationPrompt: prompt,
        });
      const initial = yield* stack.deploy(
        fixture("Explain why access is needed"),
      );
      expect(
        (yield* zeroTrust.getAccessPolicy({
          accountId,
          policyId: initial.policyId,
        })).purposeJustificationPrompt,
      ).toEqual("Explain why access is needed");
      const updated = yield* stack.deploy(
        fixture("Provide the incident identifier"),
      );
      expect(updated.policyId).toEqual(initial.policyId);
      expect(
        (yield* zeroTrust.getAccessPolicy({
          accountId,
          policyId: initial.policyId,
        })).purposeJustificationPrompt,
      ).toEqual("Provide the incident identifier");
      yield* zeroTrust.deleteAccessPolicy({
        accountId,
        policyId: initial.policyId,
      });
      const recreated = yield* stack.deploy(
        fixture("Provide the change identifier"),
      );
      expect(recreated.policyId).not.toEqual(initial.policyId);
      expect(
        (yield* zeroTrust.getAccessPolicy({
          accountId,
          policyId: recreated.policyId,
        })).purposeJustificationPrompt,
      ).toEqual("Provide the change identifier");
      yield* zeroTrust.deleteAccessPolicy({
        accountId,
        policyId: recreated.policyId,
      });
      // Destroy must remain idempotent when a previous delete already succeeded.
      yield* stack.destroy();
    }).pipe(logLevel),
);
