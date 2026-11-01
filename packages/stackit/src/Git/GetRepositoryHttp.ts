import * as forgejo from "@distilled.cloud/stackit/git_forgejo";
import * as Layer from "effect/Layer";
import { makeRepositoryBinding } from "./BindingHttp.ts";
import { GetRepository } from "./GetRepository.ts";

/**
 * HTTP implementation of {@link GetRepository}.
 *
 * @layer
 * @provides Stackit.Git.GetRepository
 */
export const GetRepositoryHttp = Layer.effect(
  GetRepository,
  makeRepositoryBinding({
    tag: "Stackit.Git.GetRepository",
    operation: forgejo.getRepository,
  }),
);
