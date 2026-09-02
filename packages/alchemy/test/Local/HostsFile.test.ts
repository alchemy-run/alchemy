import {
  hostUrl,
  portForwardCommands,
  subdomainFor,
} from "@/Local/DevIngress.ts";
import {
  BEGIN_MARKER,
  END_MARKER,
  hostsAddCommand,
  isNativelyLocal,
  managedHosts,
  missingHosts,
  parseHosts,
  removeHosts,
  upsertHosts,
} from "@/Local/HostsFile.ts";
import { releaseAsset, releaseUrl } from "@/Local/QuickTunnel.ts";
import { describe, expect, it } from "alchemy-test";

const SYSTEM = `##
# Host Database
##
127.0.0.1\tlocalhost
255.255.255.255\tbroadcasthost
::1             localhost
192.168.1.20 nas.home # my NAS
`;

describe("HostsFile", () => {
  it("parses every mapped hostname, ignoring comments", () => {
    expect([...parseHosts(SYSTEM)]).toEqual([
      "localhost",
      "broadcasthost",
      "nas.home",
    ]);
  });

  it("reports hosts with no mapping", () => {
    expect(
      missingHosts(SYSTEM, ["api.myapp.test", "localhost", "NAS.home"]),
    ).toEqual(["api.myapp.test"]);
  });

  it("appends a managed block and keeps the rest of the file intact", () => {
    const next = upsertHosts(SYSTEM, ["api.myapp.test", "web.myapp.test"]);
    expect(next.startsWith(SYSTEM)).toBe(true);
    expect(next).toContain(BEGIN_MARKER);
    expect(next).toContain(END_MARKER);
    expect(next).toContain("127.0.0.1 api.myapp.test");
    expect(next).toContain("::1 api.myapp.test");
    expect(next.endsWith(`${END_MARKER}\n`)).toBe(true);
    expect(managedHosts(next)).toEqual(["api.myapp.test", "web.myapp.test"]);
    expect(missingHosts(next, ["api.myapp.test"])).toEqual([]);
  });

  it("is idempotent and merges into the existing block", () => {
    const once = upsertHosts(SYSTEM, ["api.myapp.test"]);
    const twice = upsertHosts(once, ["api.myapp.test"]);
    expect(twice).toBe(once);
    const three = upsertHosts(twice, ["web.myapp.test"]);
    expect(three.split(BEGIN_MARKER)).toHaveLength(2);
    expect(managedHosts(three)).toEqual(["api.myapp.test", "web.myapp.test"]);
  });

  it("removes hosts from the block and drops an empty block", () => {
    const withBoth = upsertHosts(SYSTEM, ["api.myapp.test", "web.myapp.test"]);
    const one = removeHosts(withBoth, ["api.myapp.test"]);
    expect(managedHosts(one)).toEqual(["web.myapp.test"]);
    expect(one).not.toContain("api.myapp.test");
    const none = removeHosts(one, ["web.myapp.test"]);
    expect(none).toBe(SYSTEM);
  });

  it("never touches entries outside the block", () => {
    const next = removeHosts(upsertHosts(SYSTEM, ["nas.home"]), ["nas.home"]);
    expect(next).toContain("192.168.1.20 nas.home");
  });

  it("knows which hosts resolve without a hosts-file entry", () => {
    expect(isNativelyLocal("localhost")).toBe(true);
    expect(isNativelyLocal("api.localhost")).toBe(true);
    expect(isNativelyLocal("api.myapp.localhost")).toBe(true);
    expect(isNativelyLocal("api.myapp.test")).toBe(false);
    expect(isNativelyLocal("localhost.example.com")).toBe(false);
  });

  it("prints the sudo command the user runs", () => {
    expect(hostsAddCommand(["api.myapp.test", "web.myapp.test"])).toBe(
      "sudo alchemy hosts add api.myapp.test web.myapp.test",
    );
  });
});

describe("DevIngress naming", () => {
  it("kebab-cases logical ids and nests namespaces innermost first", () => {
    expect(subdomainFor("Api")).toBe("api");
    expect(subdomainFor("MyApi")).toBe("my-api");
    expect(subdomainFor("HTTPServer")).toBe("http-server");
    expect(subdomainFor("Site/Api")).toBe("api.site");
    expect(subdomainFor("my_worker v2")).toBe("my-worker-v2");
  });

  it("omits the port only for :80", () => {
    expect(hostUrl("api.localhost", 1337)).toBe("http://api.localhost:1337");
    expect(hostUrl("api.localhost", 80)).toBe("http://api.localhost");
    expect(hostUrl("api.localhost", undefined)).toBe("http://api.localhost");
  });

  it("offers a port-forward command per platform", () => {
    expect(portForwardCommands(80, 1337, "darwin")[0]).toContain("pfctl");
    expect(portForwardCommands(80, 1337, "linux")[0]).toContain("iptables");
    expect(portForwardCommands(80, 1337, "win32")).toEqual([]);
  });
});

describe("QuickTunnel releases", () => {
  it("maps platforms to cloudflared release assets", () => {
    expect(releaseAsset("darwin", "arm64")).toEqual({
      asset: "cloudflared-darwin-arm64.tgz",
      archive: "tgz",
    });
    expect(releaseAsset("linux", "x64")).toEqual({
      asset: "cloudflared-linux-amd64",
      archive: "binary",
    });
    expect(releaseAsset("win32", "x64")).toEqual({
      asset: "cloudflared-windows-amd64.exe",
      archive: "binary",
    });
    expect(releaseAsset("freebsd", "x64")).toBeUndefined();
    expect(releaseUrl("cloudflared-linux-amd64", "2026.8.3")).toBe(
      "https://github.com/cloudflare/cloudflared/releases/download/2026.8.3/cloudflared-linux-amd64",
    );
  });
});
