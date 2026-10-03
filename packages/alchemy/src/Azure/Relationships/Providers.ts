import * as Layer from "effect/Layer";
import { DependencyOf, DependencyOfProvider } from "./DependencyOf.ts";
import {
  ServiceGroupDependencyOf,
  ServiceGroupDependencyOfProvider,
} from "./ServiceGroupDependencyOf.ts";
import {
  ServiceGroupMember,
  ServiceGroupMemberProvider,
} from "./ServiceGroupMember.ts";

export const resources = [
  DependencyOf,
  ServiceGroupDependencyOf,
  ServiceGroupMember,
];
export const layers = () =>
  Layer.mergeAll(
    DependencyOfProvider(),
    ServiceGroupDependencyOfProvider(),
    ServiceGroupMemberProvider(),
  );
