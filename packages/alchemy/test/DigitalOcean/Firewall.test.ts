import {
  createFirewall,
  createTag,
  deleteFirewall,
  deleteTag,
  getFirewall,
} from "@distilled.cloud/digitalocean";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as DigitalOcean from "@/DigitalOcean";
import { Firewall, sameRules, type FirewallInboundRule } from "@/DigitalOcean/Firewall";
import * as Test from "@/Test/Alchemy";
import { forgetAttributes, isGone, logLevel, skipLive } from "./support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const FIREWALL_NAME = "alchemy-test-firewall";
const RENAMED_FIREWALL_NAME = "alchemy-test-firewall-renamed";
const TAGGED_FIREWALL_NAME = "alchemy-test-firewall-tagged";
const FOREIGN_FIREWALL_NAME = "alchemy-test-firewall-foreign";
const NO_OUTBOUND_FIREWALL_NAME = "alchemy-test-firewall-no-outbound";
const DROPLET_TAG = "alchemy-test-firewall-droplets";

const EVERYWHERE = ["0.0.0.0/0", "::/0"];

const SSH_ONLY: FirewallInboundRule[] = [{ protocol: "tcp", ports: "22", addresses: EVERYWHERE }];

const WEB_RULES: FirewallInboundRule[] = [
  { protocol: "tcp", ports: "22", addresses: EVERYWHERE },
  { protocol: "tcp", ports: "80", addresses: EVERYWHERE },
  { protocol: "tcp", ports: "443", addresses: EVERYWHERE },
];

const UNIT_TAGS = ["unit", "provider:digitalocean", "provider:digitalocean:firewall", "local"];
const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:firewall", "live"];
const LIVE_TIMEOUT = 180_000;

describe("sameRules", { tags: UNIT_TAGS }, () => {
  it("ignores rule order", () => {
    expect(sameRules(WEB_RULES, [...WEB_RULES].reverse())).toBe(true);
  });

  it("ignores address order and case", () => {
    expect(
      sameRules(
        [{ protocol: "tcp", ports: "22", addresses: ["0.0.0.0/0", "2001:DB8::/32"] }],
        [{ protocol: "tcp", ports: "22", addresses: ["2001:db8::/32", "0.0.0.0/0"] }],
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

  it("treats a missing action as allow", () => {
    expect(
      sameRules(
        [{ protocol: "tcp", ports: "22", addresses: ["0.0.0.0/0"] }],
        [{ protocol: "tcp", ports: "22", action: "allow", addresses: ["0.0.0.0/0"] }],
      ),
    ).toBe(true);
    expect(
      sameRules(
        [{ protocol: "tcp", ports: "22", addresses: ["0.0.0.0/0"] }],
        [{ protocol: "tcp", ports: "22", action: "deny", addresses: ["0.0.0.0/0"] }],
      ),
    ).toBe(false);
  });

  it("compares load balancer and kubernetes members", () => {
    expect(
      sameRules(
        [{ protocol: "tcp", ports: "443", loadBalancerUids: ["lb-1"], kubernetesIds: ["k8s-1"] }],
        [{ protocol: "tcp", ports: "443", kubernetesIds: ["k8s-1"], loadBalancerUids: ["lb-1"] }],
      ),
    ).toBe(true);
    expect(
      sameRules(
        [{ protocol: "tcp", ports: "443", loadBalancerUids: ["lb-1"] }],
        [{ protocol: "tcp", ports: "443", loadBalancerUids: ["lb-2"] }],
      ),
    ).toBe(false);
  });

  it("treats omitted member lists as empty", () => {
    expect(
      sameRules(
        [{ protocol: "tcp", ports: "22", addresses: ["0.0.0.0/0"] }],
        [{ protocol: "tcp", ports: "22", addresses: ["0.0.0.0/0"], dropletIds: [], tags: [] }],
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
          { protocol: "tcp", ports: "22", addresses: ["0.0.0.0/0"], dropletIds: [1] },
        ],
        [{ protocol: "tcp", ports: "22", addresses: ["0.0.0.0/0"], dropletIds: [1] }],
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

const readFirewall = (firewallId: string) =>
  getFirewall({ firewall_id: firewallId }).pipe(Effect.map((response) => response.firewall));

const isFirewallGone = (firewallId: string) => isGone(getFirewall({ firewall_id: firewallId }));

const deleteFirewallIfExists = (firewallId: string) =>
  deleteFirewall({ firewall_id: firewallId }).pipe(Effect.catchTag("NotFound", () => Effect.void));

const deleteTagIfExists = (tag: string) =>
  deleteTag({ tag_id: tag }).pipe(Effect.catchTag("NotFound", () => Effect.void));

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
      expect(created.inboundRules).toHaveLength(1);
      expect(created.inboundRules[0]?.action).toEqual("allow");
      expect(created.outboundRules.map((rule) => rule.protocol).sort()).toEqual([
        "icmp",
        "tcp",
        "udp",
      ]);

      const remote = yield* readFirewall(created.firewallId);
      expect(remote.name).toEqual(FIREWALL_NAME);
      expect(remote.inbound_rules ?? []).toHaveLength(1);

      const widened = yield* stack.deploy(
        Firewall("TestFirewall", { name: RENAMED_FIREWALL_NAME, inboundRules: WEB_RULES }),
      );
      expect(widened.firewallId).toEqual(created.firewallId);
      expect(widened.name).toEqual(RENAMED_FIREWALL_NAME);
      expect(widened.inboundRules.map((rule) => rule.ports).sort()).toEqual(["22", "443", "80"]);

      const remoteWidened = yield* readFirewall(created.firewallId);
      expect(remoteWidened.name).toEqual(RENAMED_FIREWALL_NAME);
      expect(remoteWidened.inbound_rules ?? []).toHaveLength(3);

      yield* stack.destroy();

      expect(yield* isFirewallGone(created.firewallId)).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

test.provider.skipIf(skipLive)(
  "tags select the droplets a firewall protects and update in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* deleteTagIfExists(DROPLET_TAG);
      yield* createTag({ name: DROPLET_TAG });
      yield* Effect.addFinalizer(() => deleteTagIfExists(DROPLET_TAG).pipe(Effect.orDie));

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

      const foreign = yield* createFirewall({
        name: FOREIGN_FIREWALL_NAME,
        inbound_rules: [{ protocol: "tcp", ports: "22", sources: { addresses: EVERYWHERE } }],
      }).pipe(Effect.map((response) => response.firewall));
      yield* Effect.addFinalizer(() => deleteFirewallIfExists(foreign.id).pipe(Effect.orDie));

      const refused = yield* stack
        .deploy(Firewall("Adopted", { name: FOREIGN_FIREWALL_NAME, inboundRules: SSH_ONLY }))
        .pipe(Effect.flip);
      expect(refused).toBeInstanceOf(OwnedBySomeoneElse);

      const adopted = yield* stack.deploy(
        Firewall("Adopted", { name: FOREIGN_FIREWALL_NAME, inboundRules: WEB_RULES }).pipe(
          adopt(true),
        ),
      );
      expect(adopted.firewallId).toEqual(foreign.id);
      expect(adopted.inboundRules).toHaveLength(3);

      yield* stack.destroy();

      expect(yield* isFirewallGone(foreign.id)).toBe(true);
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
