import {
  compareVersions,
  isCredentialExpiring,
  isCredentialRevoked,
  mintedAtOf,
  resolveMinimumVersion,
  sameClusterSpec,
  timeOfDay,
} from "@alchemy.run/stackit/SKE/internal";
import { parseKubeconfig } from "@alchemy.run/stackit/SKE/KubernetesAdapter";
import { describe, expect, it } from "@alchemy.run/test";
import type * as ske from "@distilled.cloud/stackit/ske";

const offered = [
  { version: "1.30.9", state: "deprecated" },
  { version: "1.31.4", state: "supported" },
  { version: "1.31.5", state: "supported" },
  { version: "1.32.1", state: "supported" },
  { version: "1.33.0", state: "preview" },
];

describe("resolveMinimumVersion", () => {
  it("takes the newest supported version with no minimum and no cluster", () => {
    expect(resolveMinimumVersion({ minimum: undefined, current: undefined, offered })).toBe(
      "1.32.1",
    );
  });

  it("keeps the live version with no minimum", () => {
    expect(resolveMinimumVersion({ minimum: undefined, current: "1.31.4", offered })).toBe(
      "1.31.4",
    );
  });

  it("never downgrades a live version maintenance moved past the minimum", () => {
    expect(resolveMinimumVersion({ minimum: "1.31", current: "1.32.1", offered })).toBe("1.32.1");
    expect(resolveMinimumVersion({ minimum: "1.31.4", current: "1.34.0", offered })).toBe("1.34.0");
  });

  it("takes the newest match of a prefix", () => {
    expect(resolveMinimumVersion({ minimum: "1.31", current: undefined, offered })).toBe("1.31.5");
  });

  it("upgrades a live version below the minimum", () => {
    expect(resolveMinimumVersion({ minimum: "1.32", current: "1.31.4", offered })).toBe("1.32.1");
  });

  it("takes a preview only when nothing supported matches", () => {
    expect(resolveMinimumVersion({ minimum: "1.33", current: undefined, offered })).toBe("1.33.0");
    expect(
      resolveMinimumVersion({
        minimum: "2",
        current: undefined,
        offered: [
          { version: "2.1.0", state: "preview" },
          { version: "2.0.0", state: "supported" },
        ],
      }),
    ).toBe("2.0.0");
  });

  it("reports nothing when no version matches", () => {
    expect(resolveMinimumVersion({ minimum: "1.99", current: undefined, offered })).toBeUndefined();
    expect(
      resolveMinimumVersion({ minimum: undefined, current: undefined, offered: [] }),
    ).toBeUndefined();
  });
});

describe("compareVersions", () => {
  it("compares numerically, not as text", () => {
    expect(compareVersions("1.9.0", "1.10.0")).toBeLessThan(0);
    expect(compareVersions("1.31", "1.31.0")).toBe(0);
    expect(compareVersions("4230.2.4", "4230.2")).toBeGreaterThan(0);
  });
});

describe("sameClusterSpec", () => {
  const spec: ske.Cluster = {
    kubernetes: { version: "1.32.1" },
    labels: { a: "1", b: "2" },
    extensions: {},
    maintenance: {
      timeWindow: { start: "0000-01-01T02:00:00Z", end: "0000-01-01T04:00:00+00:00" },
    },
    nodepools: [
      {
        name: "a",
        availabilityZones: ["eu01-1", "eu01-2"],
        machine: { type: "c1.2", image: { name: "flatcar", version: "1" } },
        minimum: 1,
        maximum: 1,
        volume: { size: 20 },
      },
      {
        name: "b",
        availabilityZones: ["eu01-3"],
        machine: { type: "c1.2", image: { name: "flatcar", version: "1" } },
        minimum: 0,
        maximum: 1,
        volume: { size: 20 },
      },
    ],
  };

  it("ignores order, empties, server-owned status and a window's date", () => {
    expect(
      sameClusterSpec(spec, {
        ...spec,
        status: { aggregated: "STATE_HEALTHY" },
        labels: { b: "2", a: "1" },
        extensions: undefined,
        maintenance: {
          timeWindow: { start: "2000-01-23T02:00:00Z", end: "2000-01-23T04:00:00Z" },
        },
        nodepools: [
          spec.nodepools[1]!,
          { ...spec.nodepools[0]!, availabilityZones: ["eu01-2", "eu01-1"], labels: {} },
        ],
      } as ske.Cluster),
    ).toBe(true);
  });

  it("sees a change in a node pool", () => {
    expect(
      sameClusterSpec(spec, {
        ...spec,
        nodepools: [{ ...spec.nodepools[0]!, maximum: 2 }, spec.nodepools[1]!],
      }),
    ).toBe(false);
  });

  it("sees a change in the window's time", () => {
    expect(
      sameClusterSpec(spec, {
        ...spec,
        maintenance: {
          timeWindow: { start: "0000-01-01T03:00:00Z", end: "0000-01-01T04:00:00Z" },
        },
      }),
    ).toBe(false);
  });
});

describe("timeOfDay", () => {
  it("drops the date and normalizes UTC", () => {
    expect(timeOfDay("0000-01-01T05:00:00+00:00")).toBe("05:00:00Z");
    expect(timeOfDay("05:00:00+02:00")).toBe("05:00:00+02:00");
  });
});

describe("kubeconfig expiry", () => {
  const expirationTimestamp = "2026-11-01T12:00:00Z";
  const at = (time: string) => new Date(time).getTime();

  it("is fine until the refresh window starts", () => {
    expect(
      isCredentialExpiring({
        expirationTimestamp,
        refreshBeforeSeconds: 360,
        now: at("2026-11-01T11:53:59Z"),
      }),
    ).toBe(false);
  });

  it("is expiring inside the refresh window and after it lapses", () => {
    expect(
      isCredentialExpiring({
        expirationTimestamp,
        refreshBeforeSeconds: 360,
        now: at("2026-11-01T11:54:00Z"),
      }),
    ).toBe(true);
    expect(
      isCredentialExpiring({
        expirationTimestamp,
        refreshBeforeSeconds: 0,
        now: at("2026-11-01T12:00:01Z"),
      }),
    ).toBe(true);
  });

  it("derives the mint time from the API's expiry", () => {
    expect(new Date(mintedAtOf(expirationTimestamp, 3600)).toISOString()).toBe(
      "2026-11-01T11:00:00.000Z",
    );
  });

  const cluster = (status: ske.ClusterStatus): ske.Cluster => ({
    kubernetes: { version: "1.32.1" },
    nodepools: [],
    status,
  });
  const mintedAt = "2026-11-01T11:00:00Z";

  it("is revoked by a rotation completed after the mint", () => {
    expect(
      isCredentialRevoked(
        mintedAt,
        cluster({ credentialsRotation: { lastCompletionTime: "2026-11-01T11:30:00Z" } }),
      ),
    ).toBe(true);
    expect(
      isCredentialRevoked(
        mintedAt,
        cluster({ credentialsRotation: { lastCompletionTime: "2026-11-01T10:30:00Z" } }),
      ),
    ).toBe(false);
  });

  it("is revoked by a cluster recreated after the mint", () => {
    expect(isCredentialRevoked(mintedAt, cluster({ creationTime: "2026-11-01T11:30:00Z" }))).toBe(
      true,
    );
    expect(isCredentialRevoked(mintedAt, cluster({ creationTime: "2026-10-01T00:00:00Z" }))).toBe(
      false,
    );
  });

  it("isn't revoked by a cluster that says nothing", () => {
    expect(isCredentialRevoked(mintedAt, cluster({}))).toBe(false);
  });
});

describe("parseKubeconfig", () => {
  const encode = (text: string) => Buffer.from(text, "utf8").toString("base64");
  const yaml = (user: string) => `
apiVersion: v1
kind: Config
current-context: admin
clusters:
  - name: other
    cluster: { server: "https://other.example" }
  - name: main
    cluster:
      server: https://api.example
      certificate-authority-data: Q0E=
contexts:
  - name: other
    context: { cluster: other, user: other }
  - name: admin
    context: { cluster: main, user: admin }
users:
  - name: other
    user: { token: wrong }
  - name: admin
    user: ${user}
`;

  it("follows the current context and decodes a client certificate", () => {
    const parsed = parseKubeconfig(
      yaml(`{ client-certificate-data: ${encode("CERT")}, client-key-data: ${encode("KEY")} }`),
    );
    expect(parsed?.endpoint).toBe("https://api.example");
    expect(parsed?.certificateAuthorityData).toBe("Q0E=");
    expect(parsed?.clientCert).toEqual({ certificate: "CERT", key: "KEY" });
    expect(parsed?.token).toBeUndefined();
  });

  it("reads a bearer token", () => {
    const parsed = parseKubeconfig(yaml("{ token: secret-token }"));
    expect(parsed?.token).toBe("secret-token");
    expect(parsed?.clientCert).toBeUndefined();
  });

  it("gives up on anything that isn't a kubeconfig", () => {
    expect(parseKubeconfig(": not yaml : [")).toBeUndefined();
    expect(parseKubeconfig("clusters: []")).toBeUndefined();
    expect(parseKubeconfig("")).toBeUndefined();
  });
});
