import { Bank, BankHandlers } from "@cluster-bank/domain/Bank.model";
import * as Layer from "effect/Layer";
import { SessionLive } from "./Session.ts";

/**
 * The bank's model, with the Session middleware its Api needs, on the
 * platform you give it. The platform is the one Layer that changes between
 * targets: `Domain.InMemory` in tests, `DomainCluster.layerEntities` with a
 * Docker or AWS pool when deployed.
 */
export const hostBank = <ROut, E, RIn>(platform: Layer.Layer<ROut, E, RIn>) =>
  SessionLive.pipe(Layer.provideMerge(Bank.layer(BankHandlers)), Layer.provide(platform));
