import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as dns from "@distilled.cloud/cloudflare/dns";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { testName } from "../../names.ts";
import { expectUrlContains } from "../Utils/Http.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = ["provider:cloudflare", "provider:cloudflare:dns", "live"];

// Deterministic key material (this is test-only, not a real secret).
const SECRET =
  "kyTZf6QHTPVdpDjLWWbYO7DI3Z6f3wWvECDCtMHEOSomCnq0db4DBzowg4QH51jJZUw5n4nGYNGmkJhCfn+9Ag==";

const callerScript = `export default {
  async fetch(request, env) {
    return new Response("peer:" + env.PEER);
  },
};`;

// The targets belong to another stack, as a lookup's target always should.
// The peer is declared without props, which must work: every prop is
// optional.
const TargetStack = Alchemy.Stack(
  "DnsZoneTransferLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const tsig = yield* Cloudflare.DNS.ZoneTransferTsig("lookup-target-tsig", {
      name: `${testName("alchemy-dnszt-lookup")}.`,
      algo: "hmac-sha512.",
      secret: Redacted.make(SECRET),
    });
    const peer = yield* Cloudflare.DNS.ZoneTransferPeer("lookup-target-peer");
    return {
      tsigId: tsig.tsigId.as<string>(),
      tsigName: tsig.name.as<string>(),
      peerId: peer.peerId.as<string>(),
      peerName: peer.name.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up TSIG key authenticates a new peer, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { tsigId, tsigName } = yield* target;

      const program = Effect.gen(function* () {
        const byName = Cloudflare.DNS.ZoneTransferTsig.lookup({ name: tsigName });
        const byId = Cloudflare.DNS.ZoneTransferTsig.lookup({ tsigId });
        const peer = yield* Cloudflare.DNS.ZoneTransferPeer("tsig-lookup-peer", {
          ip: "192.0.2.53",
          tsigId: byName.tsigId,
        });
        return { peerId: peer.peerId, algo: byId.algo };
      });
      const out = yield* stack.deploy(program);
      expect(out.algo).toBe("hmac-sha512.");

      const live = yield* dns.getZoneTransferPeer({ accountId, peerId: out.peerId });
      expect(live.tsigId).toBe(tsigId);

      // A lookup re-resolves to the same key, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["tsig-lookup-peer"].action).toBe("noop");

      // Destroying the stack that looked it up leaves the key alone.
      yield* stack.destroy();
      const survivor = yield* dns.getZoneTransferTsig({ accountId, tsigId });
      expect(survivor.name).toBe(tsigName);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a looked-up peer resolves by id and by name, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { peerId, peerName } = yield* target;

      const program = Effect.gen(function* () {
        const byName = Cloudflare.DNS.ZoneTransferPeer.lookup({ name: peerName });
        const byId = Cloudflare.DNS.ZoneTransferPeer.lookup({ peerId });
        const caller = yield* Cloudflare.Worker("peer-lookup-caller", {
          script: callerScript,
          workersDev: true,
          env: { PEER: byName.peerId },
        });
        return { url: caller.url.as<string>(), byIdName: byId.name };
      });
      const out = yield* stack.deploy(program);
      expect(out.byIdName).toBe(peerName);

      yield* expectUrlContains(out.url, `peer:${peerId}`, { label: "peer lookup caller" });

      const plan = yield* stack.plan(program);
      expect(plan.resources["peer-lookup-caller"].action).toBe("noop");

      yield* stack.destroy();
      const survivor = yield* dns.getZoneTransferPeer({ accountId, peerId });
      expect(survivor.name).toBe(peerName);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a lookup of a missing peer or TSIG key fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const lookups = {
        "missing-peer": Cloudflare.DNS.ZoneTransferPeer.lookup({ name }).peerId,
        "missing-tsig": Cloudflare.DNS.ZoneTransferTsig.lookup({ name }).tsigId,
      };
      for (const [id, value] of Object.entries(lookups)) {
        yield* expectDeployFails(
          stack.deploy(Cloudflare.Worker(id, { script: callerScript, env: { PEER: value } })),
          ["LookupNotFoundError", name],
        );
      }
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a peer this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => Cloudflare.DNS.ZoneTransferPeer("lookup-managed");
      const { peerId } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* Cloudflare.Worker("peer-lookup-managed-caller", {
              script: callerScript,
              env: { PEER: Cloudflare.DNS.ZoneTransferPeer.lookup({ peerId }).peerId },
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
