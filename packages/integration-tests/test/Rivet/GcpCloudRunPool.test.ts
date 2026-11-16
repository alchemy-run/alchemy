import { nodeTemplate } from "@alchemy.run/rivet/GCP/CloudRunPool";
import { startupScript } from "@alchemy.run/rivet/GCP/ComputeEnginePool";
import { nodeDockerfile, NODE_DOCKERFILE } from "@alchemy.run/rivet/internal/PoolHost";
import { describe, expect, test } from "@alchemy.run/test";

describe("RivetGCP.CloudRunPool worker pool", { tags: ["unit"] }, () => {
  test("a pool given none of the production options runs the template it always has", () => {
    expect(nodeTemplate({})).toEqual({
      containers: [{ resources: { limits: { cpu: "1", memory: "1Gi" } } }],
    });
    expect(nodeTemplate({ cpu: "2", memory: "4Gi" }, { secretEnv: [] })).toEqual({
      containers: [{ resources: { limits: { cpu: "2", memory: "4Gi" } } }],
    });
  });

  test("a pool on a private network sends private traffic through it, and runs as its account", () => {
    const secretEnv = [
      {
        name: "RIVET_TOKEN",
        valueSource: { secretKeyRef: { secret: "projects/p/secrets/rivet", version: "2" } },
      },
    ];
    expect(
      nodeTemplate(
        { network: "private", subnetwork: "private-us" },
        { serviceAccount: "nodes@p.iam.gserviceaccount.com", secretEnv },
      ),
    ).toEqual({
      serviceAccount: "nodes@p.iam.gserviceaccount.com",
      vpcAccess: {
        egress: "PRIVATE_RANGES_ONLY",
        networkInterfaces: [{ network: "private", subnetwork: "private-us" }],
      },
      containers: [{ resources: { limits: { cpu: "1", memory: "1Gi" } }, env: secretEnv }],
    });
  });
});

describe("Rivet node RivetKit release", { tags: ["unit"] }, () => {
  test("nodes install RivetKit 3.0.0 unless the pool names another release", () => {
    expect(NODE_DOCKERFILE).toBe("FROM oven/bun:1\nWORKDIR /app\nRUN bun add rivetkit@3.0.0\n");
    expect(nodeDockerfile("3.0.7")).toContain("RUN bun add rivetkit@3.0.7\n");
    const script = (rivetkitVersion?: string) =>
      startupScript({
        bucket: "b",
        image: false,
        stopTimeout: 30,
        rolloutInterval: 60,
        rivetkitVersion,
      });
    expect(script()).toContain("npm install --no-save --no-fund --no-audit rivetkit@3.0.0 ");
    expect(script("3.0.7")).toContain("npm install --no-save --no-fund --no-audit rivetkit@3.0.7 ");
  });
});
