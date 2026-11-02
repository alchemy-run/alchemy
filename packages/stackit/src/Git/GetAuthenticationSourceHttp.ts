import * as git from "@distilled.cloud/stackit/git";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetAuthenticationSource } from "./GetAuthenticationSource.ts";

/**
 * HTTP implementation of {@link GetAuthenticationSource}.
 *
 * @layer
 * @provides Stackit.Git.GetAuthenticationSource
 */
export const GetAuthenticationSourceHttp = Layer.effect(
  GetAuthenticationSource,
  makeInstanceHttpBinding({
    tag: "Stackit.Git.GetAuthenticationSource",
    permission: "git.instance.authentication-source.get",
    operation: git.getAuthentication,
  }),
);
