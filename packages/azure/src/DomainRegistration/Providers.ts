import * as Layer from "effect/Layer";
import { Domain, DomainProvider } from "./Domain.ts";
import {
  DomainOwnershipIdentifier,
  DomainOwnershipIdentifierProvider,
} from "./DomainOwnershipIdentifier.ts";

export const resources = [Domain, DomainOwnershipIdentifier];
export const layers = () => Layer.mergeAll(DomainProvider(), DomainOwnershipIdentifierProvider());
