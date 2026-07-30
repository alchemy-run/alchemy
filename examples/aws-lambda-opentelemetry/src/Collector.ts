import type { FunctionArchitecture } from "alchemy/AWS/Lambda";

/**
 * The standalone OpenTelemetry Collector Lambda extension release used by
 * this example. Keep both the collector release and Lambda layer version
 * pinned so an upstream release cannot change a deployment implicitly.
 */
export const collectorRelease = "0_22_0";
export const collectorLayerVersion = 1;

export const collectorExtensionLayerArn = ({
  region,
  architecture,
}: {
  region: string;
  architecture: FunctionArchitecture;
}) => {
  if (region.trim() === "") {
    throw new Error("AWS Region is required for the collector layer ARN");
  }
  const layerArchitecture = architecture === "x86_64" ? "amd64" : architecture;
  return `arn:aws:lambda:${region}:184161586896:layer:opentelemetry-collector-${layerArchitecture}-${collectorRelease}:${collectorLayerVersion}`;
};
