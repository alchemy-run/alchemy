/**
 * Archil region identifiers and control-plane endpoints.
 *
 * Every Archil region runs its own control plane; all API calls are routed
 * to the endpoint of the region the disk (or token) lives in.
 */
export type ArchilRegion =
  | "aws-us-east-1"
  | "aws-us-west-2"
  | "aws-eu-west-1"
  | "gcp-us-central1";

export const DEFAULT_REGION: ArchilRegion = "aws-us-east-1";

const REGION_ENDPOINTS: Record<ArchilRegion, string> = {
  "aws-us-east-1": "https://control.green.us-east-1.aws.prod.archil.com",
  "aws-us-west-2": "https://control.green.us-west-2.aws.prod.archil.com",
  "aws-eu-west-1": "https://control.green.eu-west-1.aws.prod.archil.com",
  "gcp-us-central1": "https://control.blue.us-central1.gcp.prod.archil.com",
};

/**
 * Regions where serverless execution (`exec` / `grep`) is available. Disks in
 * other regions (e.g. `gcp-us-central1`) work for storage but return
 * "Exec is not enabled" for exec requests.
 */
export const EXEC_REGIONS: ReadonlySet<ArchilRegion> = new Set([
  "aws-us-east-1",
  "aws-us-west-2",
  "aws-eu-west-1",
]);

/** Resolve the control-plane endpoint for a region. */
export const endpointForRegion = (region: ArchilRegion): string =>
  REGION_ENDPOINTS[region];

export const ALL_REGIONS = Object.keys(REGION_ENDPOINTS) as ArchilRegion[];
