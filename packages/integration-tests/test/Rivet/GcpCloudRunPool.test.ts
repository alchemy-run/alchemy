import { nodeTemplate, plainEnvironment, secretGrants } from "@alchemy.run/rivet/GCP/CloudRunPool";
import { startupScript } from "@alchemy.run/rivet/GCP/ComputeEnginePool";
import { nodeDockerfile } from "@alchemy.run/rivet/internal/PoolHost";
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

  test("a pool with secrets and no account of the user's own keeps the worker pool's account", () => {
    const options = { secrets: { DATABASE_URL: "projects/p/secrets/db/versions/3" } };
    expect(nodeTemplate(options, { serviceAccount: undefined })).not.toHaveProperty(
      "serviceAccount",
    );
    expect(secretGrants(Object.values(options.secrets))).toEqual([
      {
        role: "roles/secretmanager.secretAccessor",
        resource: { kind: "secretmanager.secret", name: "projects/p/secrets/db" },
      },
    ]);
  });

  test("RIVET_TOKEN named in secrets leaves the plain environment, and stays in it otherwise", () => {
    const env = { RIVET_ENDPOINT: "https://rivet.acme.dev", RIVET_TOKEN: "plain" };
    expect(plainEnvironment(env, { RIVET_TOKEN: "projects/p/secrets/rivet/versions/2" })).toEqual({
      RIVET_ENDPOINT: "https://rivet.acme.dev",
    });
    expect(plainEnvironment(env, undefined)).toEqual(env);
    expect(plainEnvironment(env, { DATABASE_URL: "projects/p/secrets/db/versions/3" })).toEqual(
      env,
    );
  });
});

describe("Rivet node RivetKit release", { tags: ["unit"] }, () => {
  test("nodes install RivetKit 3.0.0 unless the pool names another release", () => {
    expect(nodeDockerfile("3.0.0")).toBe(
      "FROM oven/bun:1\nWORKDIR /app\nRUN bun add rivetkit@3.0.0\n",
    );
    expect(nodeDockerfile("3.0.7")).toContain("RUN bun add rivetkit@3.0.7\n");
    const script = (rivetkitVersion?: string) =>
      startupScript({
        bucket: "b",
        image: false,
        stopTimeout: 30,
        rolloutTimeout: 600,
        rivetkitVersion,
      });
    expect(script()).toContain("npm install --no-save --no-fund --no-audit rivetkit@3.0.0 ");
    expect(script("3.0.7")).toContain("npm install --no-save --no-fund --no-audit rivetkit@3.0.7 ");
  });
});
