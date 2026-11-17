import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getLoadBalancer } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import { isGone, logLevel, skipSlow, testName } from "./support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const REGION = "sfo3";
const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:loadbalancer", "live"];
// A load balancer takes a few minutes to become active, and the droplets
// a minute or two to boot.
const LIVE_TIMEOUT = 900_000;

// Each droplet answers with its own name, so the test can see both serve.
const nginx = (body: string) =>
  [
    "#cloud-config",
    "packages: [nginx]",
    "runcmd:",
    `  - echo ${body} > /var/www/html/index.nginx-debian.html`,
    "  - systemctl restart nginx",
  ].join("\n");

const HTTP_RULE = {
  entryProtocol: "http",
  entryPort: 80,
  targetProtocol: "http",
  targetPort: 80,
} as const;

test.provider.skipIf(skipSlow)(
  "load balancer: serve two droplets, update rules and targets in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const tag = testName(stack.stage, "lb-web");

      const declare = (targets: "ids" | "tag", extraRule: boolean) =>
        Effect.gen(function* () {
          const web = yield* DigitalOcean.Tag("Web", { name: tag });
          const host = (name: string) =>
            DigitalOcean.Droplet(name, {
              region: REGION,
              size: "s-1vcpu-512mb-10gb",
              image: "ubuntu-24-04-x64",
              userData: nginx(name),
              tags: [web.name],
            });
          const a = yield* host("WebA");
          const b = yield* host("WebB");
          const lb = yield* DigitalOcean.LoadBalancer("Lb", {
            region: REGION,
            forwardingRules: extraRule
              ? [HTTP_RULE, { ...HTTP_RULE, entryPort: 8080 }]
              : [HTTP_RULE],
            healthCheck: { protocol: "http", port: 80, path: "/" },
            ...(targets === "ids" ? { dropletIds: [a.dropletId, b.dropletId] } : { tag: web.name }),
          });
          return { a, b, lb };
        });

      const created = yield* stack.deploy(declare("ids", false));
      expect(created.lb.status).toEqual("active");
      expect([...created.lb.dropletIds].sort()).toEqual(
        [created.a.dropletId, created.b.dropletId].sort(),
      );
      expect(created.lb.ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);

      // Both droplets answer through the load balancer once they are healthy.
      const client = yield* HttpClient.HttpClient;
      const seen = new Set<string>();
      yield* client.get(`http://${created.lb.ip}/`).pipe(
        Effect.flatMap((response) => response.text),
        Effect.tap((body) => Effect.sync(() => seen.add(body.trim()))),
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: () => seen.size === 2,
          times: 60,
        }),
        Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 60 }),
      );
      expect([...seen].sort()).toEqual(["WebA", "WebB"]);

      const updated = yield* stack.deploy(declare("tag", true));
      expect(updated.lb.loadBalancerId).toEqual(created.lb.loadBalancerId);
      expect(updated.lb.tag).toEqual(tag);
      const remote = yield* getLoadBalancer({ lb_id: created.lb.loadBalancerId });
      expect(remote.load_balancer.forwarding_rules.map((rule) => rule.entry_port).sort()).toEqual([
        80, 8080,
      ]);

      yield* stack.destroy();

      expect(yield* isGone(getLoadBalancer({ lb_id: created.lb.loadBalancerId }))).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);
