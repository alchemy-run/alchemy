import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as DigitalOcean from "@/DigitalOcean";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { firewallsGet } from "@distilled.cloud/digitalocean/firewalls";
import { expect, test as unit } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, outOfBand, skipLive } from "../support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const FIREWALL_NAME = "alchemy-test-firewall";
const SHARED_FIREWALL_NAME = "alchemy-test-firewall-shared";
const NO_OUTBOUND_FIREWALL_NAME = "alchemy-test-firewall-no-outbound";

const SSH_ONLY: DigitalOcean.FirewallInboundRule[] = [
  { protocol: "tcp", ports: "22", addresses: ["0.0.0.0/0", "::/0"] },
];

const WEB_RULES: DigitalOcean.FirewallInboundRule[] = [
  { protocol: "tcp", ports: "22", addresses: ["0.0.0.0/0", "::/0"] },
  { protocol: "tcp", ports: "80", addresses: ["0.0.0.0/0", "::/0"] },
  { protocol: "tcp", ports: "443", addresses: ["0.0.0.0/0", "::/0"] },
];

unit("fingerprintRules ignores rule order", () => {
  expect(DigitalOcean.sameRules(WEB_RULES, [...WEB_RULES].reverse())).toBe(
    true,
  );
});

unit("fingerprintRules ignores address order", () => {
  expect(
    DigitalOcean.sameRules(
      [{ protocol: "tcp", ports: "22", addresses: ["0.0.0.0/0", "::/0"] }],
      [{ protocol: "tcp", ports: "22", addresses: ["::/0", "0.0.0.0/0"] }],
    ),
  ).toBe(true);
});

unit("fingerprintRules collapses icmp ports to 0", () => {
  expect(
    DigitalOcean.sameRules(
      [{ protocol: "icmp", ports: "22", addresses: ["0.0.0.0/0"] }],
      [{ protocol: "icmp", ports: "0", addresses: ["0.0.0.0/0"] }],
    ),
  ).toBe(true);
});

unit("fingerprintRules treats omitted member lists as empty", () => {
  expect(
    DigitalOcean.sameRules(
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
  expect(DigitalOcean.sameRules(undefined, [])).toBe(true);
});

unit("fingerprintRules ignores repeated members and repeated rules", () => {
  expect(
    DigitalOcean.sameRules(
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

unit("fingerprintRules keeps a single port apart from a one-port range", () => {
  expect(
    DigitalOcean.sameRules(
      [{ protocol: "tcp", ports: "80", addresses: ["0.0.0.0/0"] }],
      [{ protocol: "tcp", ports: "80-80", addresses: ["0.0.0.0/0"] }],
    ),
  ).toBe(false);
});

const diffInput = (
  olds: DigitalOcean.FirewallProps,
  news: DigitalOcean.FirewallProps,
) => ({
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
    const provider = yield* Provider.findProvider(DigitalOcean.Firewall);
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
      const provider = yield* Provider.findProvider(DigitalOcean.Firewall);
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

test.provider.skipIf(skipLive)(
  "firewall lifecycle: create, widen rules in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DigitalOcean.Firewall("TestFirewall", {
            name: FIREWALL_NAME,
            tags: ["alchemy-test"],
            inboundRules: SSH_ONLY,
          });
        }),
      );
      expect(created.name).toEqual(FIREWALL_NAME);
      expect(created.status).toEqual("succeeded");
      expect(created.inboundRules).toHaveLength(1);
      // Omitted outboundRules defaulted to allow-all (tcp, udp, icmp).
      expect(created.outboundRules).toHaveLength(3);

      // Out-of-band: the firewall exists in the real account.
      const remote = yield* firewallsGet({
        firewall_id: created.firewallId,
      }).pipe(outOfBand);
      expect(remote.firewall.name).toEqual(FIREWALL_NAME);
      expect(remote.firewall.inbound_rules ?? []).toHaveLength(1);

      // Same logical id, wider rules — everything updates in place, so the
      // physical firewall id must survive.
      const widened = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DigitalOcean.Firewall("TestFirewall", {
            name: FIREWALL_NAME,
            tags: ["alchemy-test"],
            inboundRules: WEB_RULES,
          });
        }),
      );
      expect(widened.firewallId).toEqual(created.firewallId);
      expect(widened.inboundRules).toHaveLength(3);
      expect(widened.inboundRules.map((r) => r.ports).sort()).toEqual([
        "22",
        "443",
        "80",
      ]);

      // list() hydrates the exact read/Attributes shape.
      const provider = yield* Provider.findProvider(DigitalOcean.Firewall);
      const all = yield* provider.list();
      expect(
        all.find((f) => f.firewallId === created.firewallId)?.inboundRules,
      ).toHaveLength(3);

      yield* stack.destroy();

      // Typed wait-until-gone: the firewall must actually be deleted.
      const gone = yield* firewallsGet({
        firewall_id: created.firewallId,
      }).pipe(
        Effect.map(() => false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
        outOfBand,
      );
      expect(gone).toBe(true);
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
          return yield* DigitalOcean.Firewall("NoOutbound", {
            name: NO_OUTBOUND_FIREWALL_NAME,
            tags: ["alchemy-test"],
            inboundRules: SSH_ONLY,
            outboundRules: [],
          });
        }),
      );
      expect(created.outboundRules).toEqual([]);

      const remote = yield* firewallsGet({
        firewall_id: created.firewallId,
      }).pipe(outOfBand);
      expect(remote.firewall.outbound_rules ?? []).toEqual([]);

      yield* stack.destroy();
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
          return yield* DigitalOcean.Firewall("First", {
            name: SHARED_FIREWALL_NAME,
            tags: ["alchemy-test"],
            inboundRules: SSH_ONLY,
          });
        }),
      );

      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            yield* DigitalOcean.Firewall("First", {
              name: SHARED_FIREWALL_NAME,
              tags: ["alchemy-test"],
              inboundRules: SSH_ONLY,
            });
            return yield* DigitalOcean.Firewall("Second", {
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
          yield* DigitalOcean.Firewall("First", {
            name: SHARED_FIREWALL_NAME,
            tags: ["alchemy-test"],
            inboundRules: SSH_ONLY,
          });
          return yield* DigitalOcean.Firewall("Second", {
            name: SHARED_FIREWALL_NAME,
            tags: ["alchemy-test"],
            inboundRules: SSH_ONLY,
          }).pipe(adopt(true));
        }),
      );
      expect(second.firewallId).toEqual(first.firewallId);

      yield* stack.destroy();

      const gone = yield* firewallsGet({
        firewall_id: first.firewallId,
      }).pipe(
        Effect.map(() => false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
        outOfBand,
      );
      expect(gone).toBe(true);
    }).pipe(logLevel),
  { timeout: 300_000 },
);
