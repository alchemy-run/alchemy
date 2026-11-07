import * as Portless from "@alchemy.run/portless";
import { hostnameOf, routedName } from "@alchemy.run/portless/internal/Hostname";
import { problem } from "@alchemy.run/portless/internal/Lan";
import { mismatches, type ProxyState } from "@alchemy.run/portless/internal/State";
import { describe, expect, it } from "@alchemy.run/test";
import { Stage } from "alchemy/Stage";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// Pure helpers: no providers, no proxy, no network.

describe("what a LAN proxy needs from the host", { tags: ["unit"] }, () => {
  const ready = { platform: "linux", address: "192.168.0.20", mdnsInstalled: true };

  it("is nothing when there is an address and the platform's mDNS tool", () => {
    expect(problem(ready)).toBeUndefined();
    expect(problem({ ...ready, platform: "darwin" })).toBeUndefined();
  });

  it("names the mDNS tool that is missing, per platform", () => {
    const linux = problem({ ...ready, mdnsInstalled: false })!;
    expect(linux).toMatchObject({ mdnsTool: "avahi-publish-address", noAddress: false });
    expect(linux.message).toContain("avahi-publish-address");
    expect(linux.message).toContain("sudo apt install avahi-utils");

    const darwin = problem({ ...ready, platform: "darwin", mdnsInstalled: false })!;
    expect(darwin).toMatchObject({ mdnsTool: "dns-sd", noAddress: false });
    expect(darwin.message).toContain("ships with macOS");
  });

  it("names a missing network address, and how to pin one", () => {
    const missing = problem({ ...ready, address: undefined })!;
    expect(missing).toMatchObject({ mdnsTool: undefined, noAddress: true });
    expect(missing.message).toContain("PORTLESS_LAN_IP");
  });

  it("names everything missing at once, and how to leave LAN mode", () => {
    const missing = problem({ platform: "linux", address: undefined, mdnsInstalled: false })!;
    expect(missing.message).toContain("avahi-publish-address");
    expect(missing.message).toContain("no network address");
    expect(missing.message).toContain("Leave out `lan`");
  });
});

describe("a running proxy and LAN mode", { tags: ["unit"] }, () => {
  const loopback: ProxyState = {
    pid: 4242,
    port: 443,
    tls: true,
    tlds: ["localhost"],
    lan: false,
    customCertificate: false,
    certificateAuthority: "/state/ca.pem",
    hasCertificateAuthority: true,
  };
  const lan: ProxyState = { ...loopback, tlds: ["local"], lan: true };

  it("serves a stack in LAN mode only when it is a LAN proxy", () => {
    expect(mismatches(lan, 443, true)).toEqual([]);
    expect(mismatches(loopback, 443, true)).toEqual([
      "it serves .localhost, this stack needs .local only",
      "it isn't in LAN mode, which this stack needs for .local names reachable from other machines",
    ]);
  });

  it("is turned away from a stack that isn't in LAN mode", () => {
    expect(mismatches(loopback, 443)).toEqual([]);
    expect(mismatches(lan, 443)).toEqual([
      "it serves .local, this stack needs .localhost only",
      "it runs in LAN mode, which serves .local names",
    ]);
  });
});

describe("names in LAN mode", { tags: ["unit"] }, () => {
  it("end in .local", () => {
    expect(Effect.runSync(hostnameOf(routedName("Api", "dev_alice", "myapp"), "local"))).toBe(
      "dev-alice.api.myapp.local",
    );
  });

  it("are the origin Origin gives for a proxy with the .local TLD", () => {
    const origin = Portless.Origin("Api", {
      proxy: { domain: "myapp", port: 8443, tld: "local" },
    }).pipe(
      Effect.provideService(Stage, "dev_alice"),
      Effect.provide(Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({}))),
      Effect.runSync,
    );
    expect(origin).toBe("https://dev-alice.api.myapp.local:8443");
  });
});
