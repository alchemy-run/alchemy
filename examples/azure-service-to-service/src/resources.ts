import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";

/**
 * Region of the Container Apps resources. Container Apps environments
 * provision reliably in `westus2`.
 */
export const LOCATION = "westus2";

/**
 * The Container Apps environment. A Consumption workload profile has no
 * reserved cores and is free while no app runs; a runtime app needs it
 * (not `Express`) for its system-assigned managed identity.
 */
export const Environment = Azure.ContainerApps.ManagedEnvironment("Environment", {
  location: LOCATION,
  workloadProfiles: [{ name: "Consumption", workloadProfileType: "Consumption" }],
});

/**
 * The Entra application that stands for the Quotes API. Callers ask
 * Microsoft Entra ID for a token whose audience is its `appId`, and
 * Quotes' built-in authentication accepts only that audience.
 */
export const QuotesApi = Azure.Entra.Application("QuotesApi", {
  notes: "Audience of the Quotes container app (examples/azure-service-to-service).",
});

/**
 * The application's service principal. Entra ID issues tokens for an
 * audience only when it has a service principal in the tenant.
 */
export const QuotesApiPrincipal = Effect.gen(function* () {
  const api = yield* QuotesApi;
  return yield* Azure.Entra.ServicePrincipal("QuotesApiPrincipal", { appId: api.appId });
});
