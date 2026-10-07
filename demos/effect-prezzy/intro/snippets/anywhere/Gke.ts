import * as Container from "alchemy/GCP/Container";

export const Gke = Container.Cluster("Gke", { location: "us-central1", autopilot: true });
