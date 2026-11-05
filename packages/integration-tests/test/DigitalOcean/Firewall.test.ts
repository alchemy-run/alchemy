import * as DigitalOcean from "@alchemy.run/digitalocean";
import { Firewall, type FirewallRule } from "@alchemy.run/digitalocean/Firewall";
import { haveSameRules, uniqueRules } from "@alchemy.run/digitalocean/internal/firewallRules";
import { ignoreNotFound } from "@alchemy.run/digitalocean/internal/notFound";
import { describe, expect, it } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import {
  createFirewall,
  createTag,
  deleteFirewall,
  deleteTag,
  getFirewall,
} from "@distilled.cloud/digitalocean";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import { forgetAttributes, isGone, logLevel, skipLive } from "./support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const FIREWALL_NAME = "alchemy-test-firewall";
const RENAMED_FIREWALL_NAME = "alchemy-test-firewall-renamed";
const TAGGED_FIREWALL_NAME = "alchemy-test-firewall-tagged";
const FOREIGN_FIREWALL_NAME = "alchemy-test-firewall-foreign";
const NO_OUTBOUND_FIREWALL_NAME = "alchemy-test-firewall-no-outbound";
const DROPLET_TAG = "alchemy-test-firewall-droplets";

const EVERYWHERE = ["0.0.0.0/0", "::/0"];

const SSH_ONLY: FirewallRule[] = [{ protocol: "tcp", ports: "22", addresses: EVERYWHERE }];

const WEB_RULES: FirewallRule[] = [
  { protocol: "tcp", ports: "22", addresses: EVERYWHERE },
  { protocol: "tcp", ports: "80", addresses: EVERYWHERE },
  { protocol: "tcp", ports: "443", addresses: EVERYWHERE },
];

const ALL_OUTBOUND: FirewallRule[] = [
  { protocol: "tcp", ports: "0", addresses: EVERYWHERE },
  { protocol: "udp", ports: "0", addresses: EVERYWHERE },
  { protocol: "icmp", ports: "0", addresses: EVERYWHERE },
];

const UNIT_TAGS = ["unit", "provider:digitalocean", "provider:digitalocean:firewall", "local"];
const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:firewall", "live"];
const LIVE_TIMEOUT = 180_000;

describe("haveSameRules", { tags: UNIT_TAGS }, () => {
  it("ignores rule order", () => {
    expect(haveSameRules(WEB_RULES, [...WEB_RULES].reverse())).toBe(true);
  });

  it("ignores address order and case", () => {
    expect(
      haveSameRules(
        [{ protocol: "tcp", ports: "22", addresses: ["0.0.0.0/0", "2001:DB8::/32"] }],
        [{ protocol: "tcp", ports: "22", addresses: ["2001:db8::/32", "0.0.0.0/0"] }],
      ),
    ).toBe(true);
  });

  it("compares rule tags case-sensitively", () => {
    expect(
      haveSameRules(
        [{ protocol: "tcp", ports: "22", tags: ["Web"] }],
        [{ protocol: "tcp", ports: "22", tags: ["web"] }],
      ),
    ).toBe(false);
  });

  it("compares ports in canonical numeric form", () => {
    expect(
      haveSameRules(
        [{ protocol: "tcp", ports: "022", addresses: ["0.0.0.0/0"] }],
        [{ protocol: "tcp", ports: "22", addresses: ["0.0.0.0/0"] }],
      ),
    ).toBe(true);
    expect(
      haveSameRules(
        [{ protocol: "tcp", ports: "08000-09000", addresses: ["0.0.0.0/0"] }],
        [{ protocol: "tcp", ports: "8000-9000", addresses: ["0.0.0.0/0"] }],
      ),
    ).toBe(true);
  });

  it("collapses icmp ports to 0", () => {
    expect(
      haveSameRules(
        [{ protocol: "icmp", ports: "22", addresses: ["0.0.0.0/0"] }],
        [{ protocol: "icmp", ports: "0", addresses: ["0.0.0.0/0"] }],
      ),
    ).toBe(true);
  });

  it("treats a missing action as allow", () => {
    expect(
      haveSameRules(
        [{ protocol: "tcp", ports: "22", addresses: ["0.0.0.0/0"] }],
        [{ protocol: "tcp", ports: "22", action: "allow", addresses: ["0.0.0.0/0"] }],
      ),
    ).toBe(true);
    expect(
      haveSameRules(
        [{ protocol: "tcp", ports: "22", addresses: ["0.0.0.0/0"] }],
        [{ protocol: "tcp", ports: "22", action: "deny", addresses: ["0.0.0.0/0"] }],
      ),
    ).toBe(false);
  });

  it("compares load balancer and kubernetes members", () => {
    expect(
      haveSameRules(
        [{ protocol: "tcp", ports: "443", loadBalancerUids: ["lb-1"], kubernetesIds: ["k8s-1"] }],
        [{ protocol: "tcp", ports: "443", kubernetesIds: ["k8s-1"], loadBalancerUids: ["lb-1"] }],
      ),
    ).toBe(true);
    expect(
      haveSameRules(
        [{ protocol: "tcp", ports: "443", loadBalancerUids: ["lb-1"] }],
        [{ protocol: "tcp", ports: "443", loadBalancerUids: ["lb-2"] }],
      ),
    ).toBe(false);
  });

  it("treats omitted member lists as empty", () => {
    expect(
      haveSameRules(
        [{ protocol: "tcp", ports: "22", addresses: ["0.0.0.0/0"] }],
        [{ protocol: "tcp", ports: "22", addresses: ["0.0.0.0/0"], dropletIds: [], tags: [] }],
      ),
    ).toBe(true);
    expect(haveSameRules(undefined, [])).toBe(true);
  });

  it("ignores repeated members and repeated rules", () => {
    expect(
      haveSameRules(
        [
          {
            protocol: "tcp",
            ports: "22",
            addresses: ["0.0.0.0/0", "0.0.0.0/0"],
            dropletIds: [1, 1],
          },
          { protocol: "tcp", ports: "22", addresses: ["0.0.0.0/0"], dropletIds: [1] },
        ],
        [{ protocol: "tcp", ports: "22", addresses: ["0.0.0.0/0"], dropletIds: [1] }],
      ),
    ).toBe(true);
  });

  it("keeps a single port apart from a one-port range", () => {
    expect(
      haveSameRules(
        [{ protocol: "tcp", ports: "80", addresses: ["0.0.0.0/0"] }],
        [{ protocol: "tcp", ports: "80-80", addresses: ["0.0.0.0/0"] }],
      ),
    ).toBe(false);
  });

  it("tells an empty list from a list with rules", () => {
    expect(haveSameRules([], [])).toBe(true);
    expect(haveSameRules([], SSH_ONLY)).toBe(false);
  });
});

describe("uniqueRules", { tags: UNIT_TAGS }, () => {
  it("keeps one of each rule, in first-seen order", () => {
    expect(uniqueRules([...WEB_RULES, ...SSH_ONLY, ...WEB_RULES])).toEqual(WEB_RULES);
  });
});

const readFirewall = (firewallId: string) =>
  getFirewall({ firewall_id: firewallId }).pipe(Effect.map((response) => response.firewall));

const isFirewallGone = (firewallId: string) => isGone(readFirewall(firewallId));

test.provider.skipIf(skipLive)(
  "firewall lifecycle: create, rename and widen rules in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Firewall("TestFirewall", { name: FIREWALL_NAME, inboundRules: SSH_ONLY }),
      );
      expect(created.name).toEqual(FIREWALL_NAME);
      expect(created.status).toEqual("succeeded");
      expect(haveSameRules(created.inboundRules, SSH_ONLY)).toBe(true);
      expect(haveSameRules(created.outboundRules, ALL_OUTBOUND)).toBe(true);

      const remote = yield* readFirewall(created.firewallId);
      expect(remote.name).toEqual(FIREWALL_NAME);
      expect(remote.inbound_rules ?? []).toHaveLength(1);

      const widened = yield* stack.deploy(
        Firewall("TestFirewall", { name: RENAMED_FIREWALL_NAME, inboundRules: WEB_RULES }),
      );
      expect(widened.firewallId).toEqual(created.firewallId);
      expect(widened.name).toEqual(RENAMED_FIREWALL_NAME);
      expect(haveSameRules(widened.inboundRules, WEB_RULES)).toBe(true);

      const remoteWidened = yield* readFirewall(created.firewallId);
      expect(remoteWidened.name).toEqual(RENAMED_FIREWALL_NAME);
      expect(remoteWidened.inbound_rules ?? []).toHaveLength(3);

      yield* stack.destroy();

      expect(yield* isFirewallGone(created.firewallId)).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

test.provider.skipIf(skipLive)(
  "a firewall's droplet tags update in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* ignoreNotFound(deleteTag({ tag_id: DROPLET_TAG }));

      yield* Effect.acquireUseRelease(
        createTag({ name: DROPLET_TAG }),
        () =>
          Effect.gen(function* () {
            const created = yield* stack.deploy(
              Firewall("Tagged", {
                name: TAGGED_FIREWALL_NAME,
                tags: [DROPLET_TAG],
                inboundRules: SSH_ONLY,
              }),
            );
            expect(created.tags).toEqual([DROPLET_TAG]);
            expect((yield* readFirewall(created.firewallId)).tags).toEqual([DROPLET_TAG]);

            const untagged = yield* stack.deploy(
              Firewall("Tagged", { name: TAGGED_FIREWALL_NAME, inboundRules: SSH_ONLY }),
            );
            expect(untagged.firewallId).toEqual(created.firewallId);
            expect(untagged.tags).toEqual([]);
            expect((yield* readFirewall(created.firewallId)).tags ?? []).toEqual([]);

            yield* stack.destroy();

            expect(yield* isFirewallGone(created.firewallId)).toBe(true);
          }),
        () => ignoreNotFound(deleteTag({ tag_id: DROPLET_TAG })),
      );
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

test.provider.skipIf(skipLive)(
  "outboundRules: [] drops all outbound traffic",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Firewall("NoOutbound", {
          name: NO_OUTBOUND_FIREWALL_NAME,
          inboundRules: SSH_ONLY,
          outboundRules: [],
        }),
      );
      expect(created.outboundRules).toEqual([]);
      expect((yield* readFirewall(created.firewallId)).outbound_rules ?? []).toEqual([]);

      yield* stack.destroy();

      expect(yield* isFirewallGone(created.firewallId)).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

test.provider.skipIf(skipLive)(
  "a firewall created outside alchemy with the chosen name needs adopt(true)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      yield* Effect.acquireUseRelease(
        createFirewall({
          name: FOREIGN_FIREWALL_NAME,
          inbound_rules: [{ protocol: "tcp", ports: "22", sources: { addresses: EVERYWHERE } }],
        }).pipe(Effect.map((response) => response.firewall)),
        (foreignFirewall) =>
          Effect.gen(function* () {
            const refused = yield* stack
              .deploy(Firewall("Adopted", { name: FOREIGN_FIREWALL_NAME, inboundRules: SSH_ONLY }))
              .pipe(Effect.flip);
            expect(refused).toBeInstanceOf(OwnedBySomeoneElse);

            const adopted = yield* stack.deploy(
              Firewall("Adopted", { name: FOREIGN_FIREWALL_NAME, inboundRules: WEB_RULES }).pipe(
                adopt(true),
              ),
            );
            expect(adopted.firewallId).toEqual(foreignFirewall.id);
            expect(haveSameRules(adopted.inboundRules, WEB_RULES)).toBe(true);

            yield* stack.destroy();

            expect(yield* isFirewallGone(foreignFirewall.id)).toBe(true);
          }),
        (foreignFirewall) => ignoreNotFound(deleteFirewall({ firewall_id: foreignFirewall.id })),
      );
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

test.provider.skipIf(skipLive)(
  "destroy recovers a generated-name firewall without recorded attributes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(Firewall("Box", { inboundRules: SSH_ONLY }));
      yield* forgetAttributes({ stack: stack.name, stage: stack.stage, fqn: "Box" });

      yield* stack.destroy();

      expect(yield* isFirewallGone(created.firewallId)).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);
