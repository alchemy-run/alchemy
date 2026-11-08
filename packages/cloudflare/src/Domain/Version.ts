import * as Context from "effect/Context";

/**
 * The version of how Domain models lay out their Durable Objects on
 * Cloudflare. Version 0 names each class after its model too
 * (`Billing.AccountAggregate`); before it, a class was named after its
 * definition alone (`AccountAggregate`), and a deploy renames those classes
 * with `renamedFrom`, keeping their objects.
 */
export const DOMAIN_VERSION = 0;

/**
 * The Domain version a Worker's models are laid out with: always
 * {@link DOMAIN_VERSION}. Tests set `undefined` to deploy the layout from
 * before versions existed, and check that the next deploy carries it over.
 *
 * @internal
 */
export const DeployVersion = Context.Reference<number | undefined>("alchemy/Domain/DeployVersion", {
  defaultValue: () => DOMAIN_VERSION,
});
