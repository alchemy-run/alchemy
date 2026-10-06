import { getFirewall } from "@distilled.cloud/digitalocean";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as DigitalOcean from "@/DigitalOcean";
import { Firewall, sameRules, type FirewallInboundRule } from "@/DigitalOcean/Firewalls/Firewall";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { isGone, logLevel, outOfBand, skipLive } from "../support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const FIREWALL_NAME = "alchemy-test-firewall";
const SHARED_FIREWALL_NAME = "alchemy-test-firewall-shared";
const NO_OUTBOUND_FIREWALL_NAME = "alchemy-test-firewall-no-outbound";

const SSH_ONLY: FirewallInboundRule[] = [
  { protocol: "tcp", ports: "22", addresses: ["0.0.0.0/0", "::/0"] },
];

const WEB_RULES: FirewallInboundRule[] = [
  { protocol: "tcp", ports: "22", addresses: ["0.0.0.0/0", "::/0"] },
  { protocol: "tcp", ports: "80", addresses: ["0.0.0.0/0", "::/0"] },
  { protocol: "tcp", ports: "443", addresses: ["0.0.0.0/0", "::/0"] },
];

const UNIT_TAGS = ["unit", "provider:digitalocean", "provider:digitalocean:firewall", "local"];
const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:firewall", "live"];
const LIVE_TIMEOUT = 180_000;

describe("sameRules", { tags: UNIT_TAGS }, () => {
  it("ignores rule order", () => {
    expect(sameRules(WEB_RULES, [...WEB_RULES].reverse())).toBe(true);
  });

  it("ignores address order", () => {
    expect(
      sameRules(
        [{ protocol: "tcp", ports: "22", addresses: ["0.0.0.0/0", "::/0"] }],
        [{ protocol: "tcp", ports: "22", addresses: ["::/0", "0.0.0.0/0"] }],
      ),
    ).toBe(true);
  });

  it("collapses icmp ports to 0", () => {
    expect(
      sameRules(
        [{ protocol: "icmp", ports: "22", addresses: ["0.0.0.0/0"] }],
        [{ protocol: "icmp", ports: "0", addresses: ["0.0.0.0/0"] }],
      ),
    ).toBe(true);
  });

  it("treats omitted member lists as empty", () => {
    expect(
      sameRules(
        [{ protocol: "tcp", ports: "22", addresses: ["0.0.0.0/0"] }],
        [
          {
            protocol: "tcp",
            ports: "22",
            addresses: ["0.0.0.0/0"],
            dropletIds: [],
            tags: [],
          },
        ],
      ),
    ).toBe(true);
    expect(sameRules(undefined, [])).toBe(true);
  });

  it("ignores repeated members and repeated rules", () => {
    expect(
      sameRules(
        [
          {
            protocol: "tcp",
            ports: "22",
            addresses: ["0.0.0.0/0", "0.0.0.0/0"],
            dropletIds: [1, 1],
          },
          {
            protocol: "tcp",
            ports: "22",
            addresses: ["0.0.0.0/0"],
            dropletIds: [1],
          },
        ],
        [
          {
            protocol: "tcp",
            ports: "22",
            addresses: ["0.0.0.0/0"],
            dropletIds: [1],
          },
        ],
      ),
    ).toBe(true);
  });

  it("keeps a single port apart from a one-port range", () => {
    expect(
      sameRules(
        [{ protocol: "tcp", ports: "80", addresses: ["0.0.0.0/0"] }],
        [{ protocol: "tcp", ports: "80-80", addresses: ["0.0.0.0/0"] }],
      ),
    ).toBe(false);
  });

  it("tells an empty list from a list with rules", () => {
    expect(sameRules([], [])).toBe(true);
    expect(sameRules([], SSH_ONLY)).toBe(false);
  });
});

const isFirewallGone = (firewallId: string) => isGone(getFirewall({ firewall_id: firewallId }));

test.provider.skipIf(skipLive)(
  "firewall lifecycle: create, widen rules in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Firewall("TestFirewall", {
            name: FIREWALL_NAME,
            inboundRules: SSH_ONLY,
          });
        }),
      );
      expect(created.name).toEqual(FIREWALL_NAME);
      expect(created.status).toEqual("succeeded");
      expect(created.inboundRules).toHaveLength(1);
      expect(created.outboundRules.map((rule) => rule.protocol).sort()).toEqual([
        "icmp",
        "tcp",
        "udp",
      ]);

      const remote = yield* getFirewall({
        firewall_id: created.firewallId,
      }).pipe(outOfBand);
      expect(remote.firewall.name).toEqual(FIREWALL_NAME);
      expect(remote.firewall.inbound_rules ?? []).toHaveLength(1);

      const widened = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Firewall("TestFirewall", {
            name: FIREWALL_NAME,
            inboundRules: WEB_RULES,
          });
        }),
      );
      expect(widened.firewallId).toEqual(created.firewallId);
      expect(widened.inboundRules).toHaveLength(3);
      expect(widened.inboundRules.map((rule) => rule.ports).sort()).toEqual(["22", "443", "80"]);

      const provider = yield* Provider.findProvider(Firewall);
      const all = yield* provider.list();
      expect(
        all.find((firewall) => firewall.firewallId === created.firewallId)?.inboundRules,
      ).toHaveLength(3);

      yield* stack.destroy();

      expect(yield* isFirewallGone(created.firewallId)).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

test.provider.skipIf(skipLive)(
  "outboundRules: [] drops all outbound traffic",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Firewall("NoOutbound", {
            name: NO_OUTBOUND_FIREWALL_NAME,
            inboundRules: SSH_ONLY,
            outboundRules: [],
          });
        }),
      );
      expect(created.outboundRules).toEqual([]);

      const remote = yield* getFirewall({
        firewall_id: created.firewallId,
      }).pipe(outOfBand);
      expect(remote.firewall.outbound_rules ?? []).toEqual([]);

      yield* stack.destroy();

      expect(yield* isFirewallGone(created.firewallId)).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

test.provider.skipIf(skipLive)(
  "a second logical id with the same explicit name needs adopt(true)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Firewall("First", {
            name: SHARED_FIREWALL_NAME,
            inboundRules: SSH_ONLY,
          });
        }),
      );

      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            yield* Firewall("First", {
              name: SHARED_FIREWALL_NAME,
              inboundRules: SSH_ONLY,
            });
            return yield* Firewall("Second", {
              name: SHARED_FIREWALL_NAME,
              inboundRules: SSH_ONLY,
            });
          }),
        )
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(OwnedBySomeoneElse);

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Firewall("First", {
            name: SHARED_FIREWALL_NAME,
            inboundRules: SSH_ONLY,
          });
          return yield* Firewall("Second", {
            name: SHARED_FIREWALL_NAME,
            inboundRules: SSH_ONLY,
          }).pipe(adopt(true));
        }),
      );
      expect(second.firewallId).toEqual(first.firewallId);

      yield* stack.destroy();

      expect(yield* isFirewallGone(first.firewallId)).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);
