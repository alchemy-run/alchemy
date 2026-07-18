/**
 * Opt-in Kubernetes types + builders. 1:1 with the Kubernetes API — no
 * resource providers, no apply engine, no cluster abstraction. Applying
 * manifests is per-cloud (`AWS.EKS.Manifest`); platforms are per-cloud
 * (`AWS.EKS.Deployment`, `AWS.EKS.Job`).
 */
export * from "./api.ts";
export * from "./builders.ts";
