import * as Portless from "@alchemy.run/portless";
import * as Claims from "@alchemy.run/portless/internal/Claims";
import { FLOCI_CONTAINER, containerPublishing } from "@alchemy.run/portless/internal/Holder";
import { processStartTime } from "@alchemy.run/portless/internal/Identity";
import { portOf } from "@alchemy.run/portless/internal/LoopbackUrl";
import { mismatches, type ProxyState } from "@alchemy.run/portless/internal/State";
import { describe, expect, it } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const { test } = Test.make({ providers: Layer.empty });

describe("Alias urls", () => {
  it("name the port of a loopback http url", () => {
    for (const [url, port] of [
      ["http://localhost:4566", 4566],
      ["http://LOCALHOST:4566/some/path", 4566],
      ["http://127.0.0.1:9000", 9000],
      ["http://[::1]:3000", 3000],
      ["http://localhost", 80],
    ] as const) {
      expect(Effect.runSync(portOf(url))).toBe(port);
    }
  });

  it("reject anything else with a reason", () => {
    for (const url of [
      "http://example.com:4566",
      "http://192.168.1.10:4566",
      "http://0.0.0.0:4566",
      "http://foo.localhost:3000",
      "https://localhost:4566",
      "ftp://localhost:21",
      "localhost:4566",
      "",
    ]) {
      const error = Effect.runSync(Effect.flip(portOf(url)));
      expect(error._tag).toBe("AliasUrlInvalid");
      expect(error.message).toContain(url === "" ? "can't route to" : url);
    }
  });
});

describe("a running proxy's settings", () => {
  const compatible: ProxyState = {
    pid: 4242,
    port: 443,
    tls: true,
    tlds: ["localhost"],
    unprivileged: true,
    lan: false,
    customCertificate: false,
    certificateAuthority: "/state/ca.pem",
    hasCertificateAuthority: true,
  };

  it("are compatible when they are HTTPS, .localhost only, unprivileged and Portless's own CA", () => {
    expect(mismatches(compatible, 443)).toEqual([]);
  });

  it("say what differs", () => {
    expect(mismatches({ ...compatible, port: 1355 }, 443)).toEqual([
      "it listens on port 1355, this stack needs 443",
    ]);
    expect(mismatches({ ...compatible, tls: false }, 443)).toEqual([
      "it serves plain HTTP, this stack needs HTTPS",
    ]);
    expect(mismatches({ ...compatible, tlds: ["localhost", "test"] }, 443)).toEqual([
      "it serves .localhost, .test, this stack needs .localhost only",
    ]);
    expect(mismatches({ ...compatible, unprivileged: false }, 443)).toEqual([
      "it wasn't started with --unprivileged, which this stack needs to never ask for root",
    ]);
    expect(mismatches({ ...compatible, lan: true }, 443)).toEqual([
      "it runs in LAN mode, which serves .local names",
    ]);
    expect(mismatches({ ...compatible, customCertificate: true }, 443)).toEqual([
      "it serves a custom certificate, this stack needs Portless's own CA",
    ]);
    expect(mismatches({ ...compatible, hasCertificateAuthority: false }, 443)).toEqual([
      "/state/ca.pem is missing",
    ]);
  });

  it("list every difference at once", () => {
    expect(mismatches({ ...compatible, tls: false, unprivileged: false }, 443)).toHaveLength(2);
  });
});

describe("the container that holds a port", () => {
  const ps = [
    "alchemy-floci\t0.0.0.0:4566->4566/tcp, 0.0.0.0:443->443/tcp, [::]:443->443/tcp",
    "postgres\t127.0.0.1:5432->5432/tcp",
    "proxy\t127.0.0.1:8443->443/tcp",
    "",
  ].join("\n");

  it("is the one that publishes the host port", () => {
    expect(containerPublishing(ps, 443)).toBe(FLOCI_CONTAINER);
    expect(containerPublishing(ps, 4566)).toBe(FLOCI_CONTAINER);
    expect(containerPublishing(ps, 5432)).toBe("postgres");
    expect(containerPublishing(ps, 8443)).toBe("proxy");
  });

  it("is none when only a container port matches, or nothing does", () => {
    expect(containerPublishing("proxy\t127.0.0.1:8443->443/tcp", 80)).toBeUndefined();
    expect(containerPublishing("db\t5432/tcp", 5432)).toBeUndefined();
    expect(containerPublishing("", 443)).toBeUndefined();
  });
});

describe("the errors that tell a person what to do", () => {
  it("name the exact sysctl for a Linux port that needs root", () => {
    const message = new Portless.ProxyPortUnprivileged({
      port: 443,
      unprivilegedPortStart: 1024,
    }).message;
    expect(message).toContain("sudo sysctl -w net.ipv4.ip_unprivileged_port_start=443");
    expect(message).toContain("/etc/sysctl.d/");
    expect(message).toContain("never starts a root proxy");
  });

  it("say how to free the port Floci's container holds, and leave it to the person", () => {
    const message = new Portless.ProxyPortHeldByFloci({
      port: 443,
      container: "alchemy-floci",
    }).message;
    expect(message).toContain("docker stop alchemy-floci");
    expect(message).toContain("docker rm -f alchemy-floci");
  });
});

describe("claims", () => {
  it("let one resource instance take a hostname again, and refuse another", () =>
    Effect.gen(function* () {
      const host = "claims.test.localhost";
      const first = yield* Claims.claim(host, { instanceId: "a", fqn: "Api" });
      const error = yield* Effect.flip(Claims.claim(host, { instanceId: "b", fqn: "Other" }));
      expect(error._tag).toBe("HostnameClaimed");
      expect(error).toMatchObject({ hostname: host, fqn: "Api" });
      // A restart claims again before the old claim is released: the old release
      // then leaves the hostname with the new claim.
      const restarted = yield* Claims.claim(host, { instanceId: "a", fqn: "Api" });
      expect(yield* first.release).toBe(false);
      expect(yield* restarted.release).toBe(true);
      // Free again.
      const other = yield* Claims.claim(host, { instanceId: "b", fqn: "Other" });
      expect(yield* other.release).toBe(true);
    }).pipe(Effect.runSync));
});

test(
  "a process's start time is encoded the way Portless records it",
  Effect.gen(function* () {
    const startTime = yield* processStartTime(process.pid);
    expect(startTime).toBeDefined();
    if (process.platform === "linux") {
      // Ticks since boot, field 22 of /proc/<pid>/stat.
      expect(startTime).toMatch(/^\d+$/);
    } else {
      // `ps -o lstart=` in the C locale and UTC, with single spaces: "Sat Oct 31 19:26:34 2026".
      expect(startTime).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d\d:\d\d:\d\d \d{4}$/);
      expect(startTime).not.toContain("  ");
    }
    // A process that is gone has none.
    expect(yield* processStartTime(2 ** 22 + 12345)).toBeUndefined();
  }),
);
