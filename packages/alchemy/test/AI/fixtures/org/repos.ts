/**
 * The repositories the organization manages, as plain refs (used to scope
 * EventSources) and as provisioned `GitHub.Repository` resources (see
 * stack.ts). The same program that defines the agents provisions the
 * surfaces they operate on.
 */
import type { RepositoryRef } from "@/GitHub/index.ts";

export const alchemyEffect: RepositoryRef = {
  owner: "alchemy-run",
  repository: "alchemy-effect",
};

export const distilled: RepositoryRef = {
  owner: "alchemy-run",
  repository: "distilled",
};

export const repositories = [alchemyEffect, distilled];
