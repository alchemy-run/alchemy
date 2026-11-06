import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectUrlContains } from "../Utils/Http.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = ["provider:cloudflare", "provider:cloudflare:gateway", "live"];

// Gateway locations need an entitlement the standing test account lacks
// ("This account does not have access to this feature"; Location.test.ts is
// skipped for the same reason). Set CLOUDFLARE_TEST_GATEWAY_LOCATIONS=1 on an
// entitled account.
const locationsEntitled = !!process.env.CLOUDFLARE_TEST_GATEWAY_LOCATIONS;

const callerScript = `export default {
  async fetch(request, env) {
    return new Response("ref:" + env.REF);
  },
};`;

// The targets belong to another stack, as a lookup's target always should.
// The certificate is declared without props, which must work: every prop is
// optional.
const TargetStack = Alchemy.Stack(
  "GatewayLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const list = yield* Cloudflare.Gateway.List("lookup-target-list", {
      type: "DOMAIN",
      items: [{ value: "lookup.alchemy-test.example" }],
    });
    const certificate = yield* Cloudflare.Gateway.Certificate("lookup-target-certificate");
    return {
      listId: list.listId.as<string>(),
      listName: list.name.as<string>(),
      certificateId: certificate.certificateId.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

// Declared without props, which must work: every prop is optional.
const LocationTargetStack = Alchemy.Stack(
  "GatewayLocationLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const location = yield* Cloudflare.Gateway.Location("lookup-target");
    return { locationId: location.locationId.as<string>(), name: location.name.as<string>() };
  }),
);

const locationTarget = beforeAll(
  locationsEntitled ? deploy(LocationTargetStack) : Effect.succeed({ locationId: "", name: "" }),
);
afterAll.skipIf(!locationsEntitled || !!process.env.NO_DESTROY)(destroy(LocationTargetStack));

test.provider(
  "a looked-up list names the domains a new rule blocks, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { listId, listName } = yield* target;

      const program = Effect.gen(function* () {
        const byName = Cloudflare.Gateway.List.lookup({ name: listName });
        const byId = Cloudflare.Gateway.List.lookup({ listId });
        const rule = yield* Cloudflare.Gateway.Rule("list-lookup-rule", {
          action: "block",
          filters: ["dns"],
          traffic: Output.interpolate`any(dns.domains[*] in $${byName.listId})`,
        });
        return { ruleId: rule.ruleId, count: byId.count };
      });
      const out = yield* stack.deploy(program);
      expect(out.count).toBe(1);

      const live = yield* zeroTrust.getGatewayRule({ accountId, ruleId: out.ruleId });
      expect((live.traffic ?? "").replaceAll("-", "")).toContain(listId.replaceAll("-", ""));

      // A lookup re-resolves to the same list, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["list-lookup-rule"].action).toBe("noop");

      // Destroying the stack that looked it up leaves the list alone.
      yield* stack.destroy();
      const survivor = yield* zeroTrust.getGatewayList({ accountId, listId });
      expect(survivor.name).toBe(listName);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a looked-up certificate resolves by id, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { certificateId } = yield* target;

      const program = Effect.gen(function* () {
        const certificate = Cloudflare.Gateway.Certificate.lookup({ certificateId });
        const caller = yield* Cloudflare.Worker("certificate-lookup-caller", {
          script: callerScript,
          workersDev: true,
          env: { REF: certificate.certificateId },
        });
        return { url: caller.url.as<string>(), fingerprint: certificate.fingerprint };
      });
      const out = yield* stack.deploy(program);
      expect(out.fingerprint).toBeTruthy();

      yield* expectUrlContains(out.url, `ref:${certificateId}`, {
        label: "certificate lookup caller",
      });

      const plan = yield* stack.plan(program);
      expect(plan.resources["certificate-lookup-caller"].action).toBe("noop");

      yield* stack.destroy();
      const certificate = yield* zeroTrust.getGatewayCertificate({ accountId, certificateId });
      expect(certificate.id).toBe(certificateId);
    }),
  { tags, timeout: 240_000 },
);

test.provider.skipIf(!locationsEntitled)(
  "a looked-up location resolves by id and by name, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { locationId, name } = yield* locationTarget;

      const program = Effect.gen(function* () {
        const byName = Cloudflare.Gateway.Location.lookup({ name });
        const byId = Cloudflare.Gateway.Location.lookup({ locationId });
        const caller = yield* Cloudflare.Worker("location-lookup-caller", {
          script: callerScript,
          workersDev: true,
          env: { REF: byName.locationId },
        });
        return { url: caller.url.as<string>(), byIdName: byId.name };
      });
      const out = yield* stack.deploy(program);
      expect(out.byIdName).toBe(name);

      yield* expectUrlContains(out.url, `ref:${locationId}`, { label: "location lookup caller" });

      const plan = yield* stack.plan(program);
      expect(plan.resources["location-lookup-caller"].action).toBe("noop");

      yield* stack.destroy();
      const location = yield* zeroTrust.getGatewayLocation({ accountId, locationId });
      expect(location.name).toBe(name);
    }),
  { tags, timeout: 240_000 },
);

test.provider.skipIf(!locationsEntitled)(
  "a lookup of a missing location fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.Worker("missing-location", {
            script: callerScript,
            env: { REF: Cloudflare.Gateway.Location.lookup({ name }).locationId },
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing list or certificate fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const missingId = "00000000-0000-4000-8000-000000000000";
      const lookups = {
        "missing-list": Cloudflare.Gateway.List.lookup({ name }).listId,
        "missing-certificate": Cloudflare.Gateway.Certificate.lookup({ certificateId: missingId })
          .certificateId,
      };
      for (const [id, value] of Object.entries(lookups)) {
        yield* expectDeployFails(
          stack.deploy(Cloudflare.Worker(id, { script: callerScript, env: { REF: value } })),
          ["LookupNotFoundError"],
        );
      }
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a list this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () =>
        Cloudflare.Gateway.List("lookup-managed", {
          type: "DOMAIN",
          items: [{ value: "managed.alchemy-test.example" }],
        });
      const { listId } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* Cloudflare.Worker("list-lookup-managed-caller", {
              script: callerScript,
              env: { REF: Cloudflare.Gateway.List.lookup({ listId }).listId },
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
