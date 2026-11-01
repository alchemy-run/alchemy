import * as git from "@distilled.cloud/stackit/git";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListAuthenticationSources } from "./ListAuthenticationSources.ts";

/**
 * HTTP implementation of {@link ListAuthenticationSources}.
 *
 * @layer
 * @provides Stackit.Git.ListAuthenticationSources
 */
export const ListAuthenticationSourcesHttp = Layer.effect(
  ListAuthenticationSources,
  makeInstanceHttpBinding({
    tag: "Stackit.Git.ListAuthenticationSources",
    permission: "git.instance.authentication-source.list",
    operation: git.listAuthentication,
  }),
);
