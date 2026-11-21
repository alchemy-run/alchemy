import * as Provider from "alchemy/Provider";
import * as Layer from "effect/Layer";
import { Revision, RevisionProvider } from "./Revision.ts";

/** Service tag bundling the providers every Domain platform that deploys objects needs. */
export class Providers extends Provider.ProviderCollection<Providers>()("Domain") {}

/**
 * The providers of Domain models hosted on Rivet or Effect Cluster: the
 * {@link Revision} a deploy counts its consumer changes with. Add it next to
 * the host's own providers in any Stack that deploys a model with
 * `DomainRivet.layerDurableObjects()` or `DomainEffectCluster.layerEntities()`.
 */
export const providers = () =>
  Layer.effect(Providers, Provider.collection([Revision])).pipe(Layer.provide(RevisionProvider()));
