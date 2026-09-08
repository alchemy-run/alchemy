import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as DigitalOcean from "@/DigitalOcean";
import {
  Firewall,
  sameRules,
  type FirewallInboundRule,
  type FirewallProps,
} from "@/DigitalOcean/Firewalls/Firewall";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { getFirewall } from "@distilled.cloud/digitalocean";
import { expect, test as unit } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, outOfBand, skipLive } from "../support.ts";

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

unit("sameRules ignores rule order", () => {
  expect(sameRules(WEB_RULES, [...WEB_RULES].reverse())).toBe(true);
});

unit("sameRules ignores address order", () => {
  expect(
    sameRules(
      [{ protocol: "tcp", ports: "22", addresses: ["0.0.0.0/0", "::/0"] }],
      [{ protocol: "tcp", ports: "22", addresses: ["::/0", "0.0.0.0/0"] }],
    ),
  ).toBe(true);
});

unit("sameRules collapses icmp ports to 0", () => {
  expect(
    sameRules(
      [{ protocol: "icmp", ports: "22", addresses: ["0.0.0.0/0"] }],
      [{ protocol: "icmp", ports: "0", addresses: ["0.0.0.0/0"] }],
    ),
  ).toBe(true);
});

unit("sameRules treats omitted member lists as empty", () => {
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

unit("sameRules ignores repeated members and repeated rules", () => {
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

unit("sameRules keeps a single port apart from a one-port range", () => {
  expect(
    sameRules(
      [{ protocol: "tcp", ports: "80", addresses: ["0.0.0.0/0"] }],
      [{ protocol: "tcp", ports: "80-80", addresses: ["0.0.0.0/0"] }],
    ),
  ).toBe(false);
});

const diffInput = (olds: FirewallProps, news: FirewallProps) => ({
  id: "TestFirewall",
  fqn: "TestFirewall",
  instanceId: "instance",
  olds,
  news,
  oldBindings: [],
  newBindings: [],
  output: {
    firewallId: "fw-1",
    name: FIREWALL_NAME,
    status: "succeeded" as const,
    dropletIds: [],
    tags: ["alchemy-test"],
    inboundRules: olds.inboundRules ?? [],
    outboundRules: olds.outboundRules ?? [],
    createdAt: "2026-01-01T00:00:00Z",
  },
});

test.provider("diff ignores rule order", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(Firewall);
    const unchanged = yield* provider.diff!(
      diffInput(
        {
          name: FIREWALL_NAME,
          tags: ["alchemy-test"],
          inboundRules: WEB_RULES,
        },
        {
          name: FIREWALL_NAME,
          tags: ["alchemy-test"],
          inboundRules: [...WEB_RULES].reverse(),
        },
      ),
    );
    expect(unchanged).toBeUndefined();
  }),
);

test.provider(
  "diff updates when outboundRules switches between [] and omitted",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(Firewall);
      const dropped = yield* provider.diff!(
        diffInput(
          { name: FIREWALL_NAME, inboundRules: SSH_ONLY },
          { name: FIREWALL_NAME, inboundRules: SSH_ONLY, outboundRules: [] },
        ),
      );
      expect(dropped).toEqual({ action: "update" });
      const restored = yield* provider.diff!(
        diffInput(
          { name: FIREWALL_NAME, inboundRules: SSH_ONLY, outboundRules: [] },
          { name: FIREWALL_NAME, inboundRules: SSH_ONLY },
        ),
      );
      expect(restored).toEqual({ action: "update" });
    }),
);

const isGone = (firewallId: string) =>
  getFirewall({ firewall_id: firewallId }).pipe(
    Effect.map(() => false),
    Effect.catchTag("NotFound", () => Effect.succeed(true)),
    outOfBand,
  );

test.provider.skipIf(skipLive)(
  "firewall lifecycle: create, widen rules in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Firewall("TestFirewall", {
            name: FIREWALL_NAME,
            tags: ["alchemy-test"],
            inboundRules: SSH_ONLY,
          });
        }),
      );
      expect(created.name).toEqual(FIREWALL_NAME);
      expect(created.status).toEqual("succeeded");
      expect(created.inboundRules).toHaveLength(1);
      // omitted outboundRules = tcp, udp, icmp allow-all
      expect(created.outboundRules).toHaveLength(3);

      const remote = yield* getFirewall({
        firewall_id: created.firewallId,
      }).pipe(outOfBand);
      expect(remote.firewall.name).toEqual(FIREWALL_NAME);
      expect(remote.firewall.inbound_rules ?? []).toHaveLength(1);

      const widened = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Firewall("TestFirewall", {
            name: FIREWALL_NAME,
            tags: ["alchemy-test"],
            inboundRules: WEB_RULES,
          });
        }),
      );
      expect(widened.firewallId).toEqual(created.firewallId);
      expect(widened.inboundRules).toHaveLength(3);
      expect(widened.inboundRules.map((rule) => rule.ports).sort()).toEqual([
        "22",
        "443",
        "80",
      ]);

      const provider = yield* Provider.findProvider(Firewall);
      const all = yield* provider.list();
      expect(
        all.find((firewall) => firewall.firewallId === created.firewallId)
          ?.inboundRules,
      ).toHaveLength(3);

      yield* stack.destroy();

      expect(yield* isGone(created.firewallId)).toBe(true);
    }).pipe(logLevel),
  { timeout: 300_000 },
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
            tags: ["alchemy-test"],
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

      expect(yield* isGone(created.firewallId)).toBe(true);
    }).pipe(logLevel),
  { timeout: 300_000 },
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
            tags: ["alchemy-test"],
            inboundRules: SSH_ONLY,
          });
        }),
      );

      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            yield* Firewall("First", {
              name: SHARED_FIREWALL_NAME,
              tags: ["alchemy-test"],
              inboundRules: SSH_ONLY,
            });
            return yield* Firewall("Second", {
              name: SHARED_FIREWALL_NAME,
              tags: ["alchemy-test"],
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
            tags: ["alchemy-test"],
            inboundRules: SSH_ONLY,
          });
          return yield* Firewall("Second", {
            name: SHARED_FIREWALL_NAME,
            tags: ["alchemy-test"],
            inboundRules: SSH_ONLY,
          }).pipe(adopt(true));
        }),
      );
      expect(second.firewallId).toEqual(first.firewallId);

      yield* stack.destroy();

      expect(yield* isGone(first.firewallId)).toBe(true);
    }).pipe(logLevel),
  { timeout: 300_000 },
);
