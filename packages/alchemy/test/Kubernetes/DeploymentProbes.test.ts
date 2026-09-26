import { havePropsChanged } from "@/Diff.ts";
import { KubeConfig } from "@/Kubernetes/Connection.ts";
import {
  makeDeploymentContainer,
  withProbePort,
  type DeploymentProps,
} from "@/Kubernetes/Deployment.ts";
import { describe, expect, it } from "alchemy-test";

// The apply request JSON-encodes the container, so compare the shape the API
// server receives (`undefined` fields dropped).
const applied = (container: ReturnType<typeof makeDeploymentContainer>) =>
  JSON.parse(JSON.stringify(container));

const container = (
  props: Parameters<typeof makeDeploymentContainer>[0]["props"],
) =>
  applied(
    makeDeploymentContainer({
      name: "api",
      image: "nginx:1.27",
      port: 8080,
      env: { PORT: "8080" },
      props,
    }),
  );

describe("Kubernetes.Deployment probes", () => {
  it("emits no probe fields when probes are omitted", () => {
    const result = container({});
    expect(result).toEqual({
      name: "api",
      image: "nginx:1.27",
      ports: [{ containerPort: 8080 }],
      env: [{ name: "PORT", value: "8080" }],
    });
    expect("readinessProbe" in result).toBe(false);
    expect("livenessProbe" in result).toBe(false);
    expect("startupProbe" in result).toBe(false);
  });

  it("emits readiness, liveness, and startup probes on the container", () => {
    const result = container({
      readinessProbe: {
        httpGet: { path: "/healthz" },
        initialDelaySeconds: 3,
        periodSeconds: 10,
        failureThreshold: 3,
      },
      livenessProbe: {
        httpGet: { path: "/healthz" },
        initialDelaySeconds: 10,
        periodSeconds: 15,
        failureThreshold: 3,
      },
      startupProbe: {
        tcpSocket: {},
        periodSeconds: 5,
        failureThreshold: 30,
      },
    });
    expect(result.readinessProbe).toEqual({
      httpGet: { path: "/healthz", port: 8080 },
      initialDelaySeconds: 3,
      periodSeconds: 10,
      failureThreshold: 3,
    });
    expect(result.livenessProbe).toEqual({
      httpGet: { path: "/healthz", port: 8080 },
      initialDelaySeconds: 10,
      periodSeconds: 15,
      failureThreshold: 3,
    });
    expect(result.startupProbe).toEqual({
      tcpSocket: { port: 8080 },
      periodSeconds: 5,
      failureThreshold: 30,
    });
  });

  it("keeps an explicit handler port", () => {
    expect(
      withProbePort(
        { httpGet: { path: "/ready", port: "metrics", scheme: "HTTPS" } },
        8080,
      ),
    ).toEqual({
      httpGet: { path: "/ready", port: "metrics", scheme: "HTTPS" },
    });
    expect(withProbePort({ tcpSocket: { port: 9000 } }, 8080)).toEqual({
      tcpSocket: { port: 9000 },
    });
    expect(withProbePort({ grpc: { service: "health" } }, 8080)).toEqual({
      grpc: { service: "health", port: 8080 },
    });
  });

  it("passes exec probes through without a port", () => {
    expect(
      withProbePort({ exec: { command: ["cat", "/tmp/ready"] } }, 8080),
    ).toEqual({ exec: { command: ["cat", "/tmp/ready"] } });
  });

  it("reports a probe change as a props change (update)", () => {
    const base: DeploymentProps = {
      cluster: KubeConfig({ context: "test" }),
      image: "nginx:1.27",
    };
    const withProbe: DeploymentProps = {
      ...base,
      readinessProbe: { httpGet: { path: "/healthz" } },
    };
    const tuned: DeploymentProps = {
      ...base,
      readinessProbe: { httpGet: { path: "/healthz" }, periodSeconds: 5 },
    };
    expect(havePropsChanged(base, withProbe)).toBe(true);
    expect(havePropsChanged(withProbe, tuned)).toBe(true);
    expect(havePropsChanged(withProbe, { ...withProbe })).toBe(false);
  });
});
