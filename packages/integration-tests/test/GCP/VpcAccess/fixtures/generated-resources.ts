import * as GCP from "@alchemy.run/gcp";

/** The smallest Serverless VPC Access connector (the Connector suite's). */
export const ProbeConnector = GCP.VpcAccess.Connector("ProbeConnector", {
  location: "us-central1",
  network: "default",
  ipCidrRange: "10.88.16.0/28",
  machineType: "e2-micro",
  minInstances: 2,
  maxInstances: 3,
});
