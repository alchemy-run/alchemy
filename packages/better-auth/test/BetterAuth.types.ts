import { anonymous } from "better-auth/plugins/anonymous";
import { organization } from "better-auth/plugins/organization";
import type { BetterAuthPlugin } from "better-auth";
import type { AuthOptions, BetterAuthInstance } from "@/BetterAuth.ts";

type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

const options = {
  user: {
    additionalFields: { department: { type: "string", required: true } },
  },
  plugins: () =>
    [organization({ teams: { enabled: true } }), anonymous()] satisfies [
      BetterAuthPlugin,
      BetterAuthPlugin,
    ],
} as const;
const arrayOptions = { ...options, plugins: options.plugins() };
type Factory = BetterAuthInstance<typeof options>;
type Array = BetterAuthInstance<typeof arrayOptions>;

export type PluginTuple = Assert<
  Equal<
    AuthOptions<typeof options>["plugins"],
    ReturnType<typeof options.plugins>
  >
>;
export type OptionalPluginFactory = Assert<
  Equal<
    AuthOptions<{ plugins?: typeof options.plugins }>["plugins"],
    ReturnType<typeof options.plugins> | undefined
  >
>;
export type PluginArrayOrFactory = Assert<
  Equal<
    AuthOptions<{
      plugins?: typeof options.plugins | ReturnType<typeof options.plugins>;
    }>["plugins"],
    ReturnType<typeof options.plugins> | undefined
  >
>;
export type OrganizationEndpoint = Assert<
  Equal<
    Factory["api"]["createOrganization"],
    Array["api"]["createOrganization"]
  >
>;
export type TeamEndpoint = Assert<
  Equal<Factory["api"]["createTeam"], Array["api"]["createTeam"]>
>;
export type InferredSession = Assert<Equal<Factory["Infer"], Array["Infer"]>>;
export type OrganizationSessionField = Assert<
  Equal<
    Factory["Infer"]["Session"]["session"]["activeOrganizationId"],
    string | null | undefined
  >
>;
export type AdditionalUserField = Assert<
  Equal<Factory["Infer"]["Session"]["user"]["department"], string>
>;
