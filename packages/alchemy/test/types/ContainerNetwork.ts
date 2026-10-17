// `Cloudflare.Container`'s `network` config was documented with a key the API
// rejects, and nothing could catch it.
//
// The doc example read `network: { assignIpv4: "predefined", mode: "public" }`,
// but the generated schema types the whole object as `unknown`
// (`network: S.optional(S.NullOr(S.Unknown))` in the distilled containers
// service), so a misspelled key compiled cleanly and only failed at deploy:
//
//   configuration.network: unrecognized key: "assignipv4"
//
// `Network` is now declared (as `Constraints` and `Affinities` already are),
// which is what makes these assertions possible. Each @ts-expect-error is a
// real check: if the type wrongly accepts, the directive itself becomes an
// error, so this file fails to compile in either direction.
import type * as Cloudflare from "@/Cloudflare";

type Network = Cloudflare.Containers.ContainerApplication.Network;

/** The shape the API accepts, and the one the docs now show. */
const privateShape: Network = {
  assign_ipv4: "none",
  assign_ipv6: "none",
  mode: "private",
};

/** Public reachability, for an account that permits it. */
const publicShape: Network = {
  assign_ipv4: "predefined",
  mode: "public",
};

// @ts-expect-error camelCase is not a key the API accepts — `unrecognized key: "assignipv4"`.
const camelCase: Network = { assignIpv4: "predefined" };

// @ts-expect-error only the documented values; a typo must not compile.
const badMode: Network = { mode: "publicly" };

// @ts-expect-error only the documented values.
const badAssign: Network = { assign_ipv4: "any" };

// @ts-expect-error unknown keys are not accepted.
const extraKey: Network = { mode: "private", ttl: 30 };

// Exported so the declarations are not reported as unused.
export { privateShape, publicShape };
