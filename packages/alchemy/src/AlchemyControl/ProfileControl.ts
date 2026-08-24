import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { CredentialsStore } from "../Auth/Credentials.ts";
import { withProfileCredentialsLock } from "../Auth/Lock.ts";
import { ProfileStore } from "../Auth/Profile.ts";
import { collectAuthProviders } from "./AuthProviders.ts";
import type { ControlContext } from "./ControlContext.ts";
import { internalize } from "./ControlEffect.ts";
import * as Operation from "./Operation.ts";
import {
  ControlNotFound,
  InvalidControlInput,
  type ConfigureProviderInput,
  type ProfileGetInput,
  type ProfileSnapshot,
  type ProfileSummary,
} from "./Surface.ts";

export const ConfigureEvent = Operation.eventSchema(
  { ConfiguringProvider: { provider: Schema.String } },
  Schema.Any,
);
export const RefreshEvent = Operation.eventSchema(
  { ProviderRefreshStarted: { provider: Schema.String } },
  Schema.Any,
);

export interface ProviderContext {
  readonly profile: string;
  readonly entrypoint?: string;
  readonly envFile?: string;
}

export const makeProfileControl = () =>
  Effect.gen(function* () {
    const context = yield* Effect.context<ControlContext>();
    const profiles = yield* ProfileStore;
    const credentials = yield* CredentialsStore;

    const current = () =>
      internalize(profiles.current.pipe(Effect.map((value) => value)));

    const list = () =>
      internalize(
        Effect.gen(function* () {
          const [manifest, selected] = yield* Effect.all([
            profiles.readManifest,
            profiles.current,
          ]);
          return Object.entries(manifest.profiles)
            .sort(([a], [b]) =>
              a === "default" ? -1 : b === "default" ? 1 : a.localeCompare(b),
            )
            .map(([name, profile]): ProfileSummary => ({
              name,
              active: name === selected.name,
              providers: Object.entries(profile.providers)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([name, config]) => ({ name, method: config.method })),
            }));
        }),
      );

    const get = (name: string, includeProviderStatus = true) =>
      internalize(
        Effect.gen(function* () {
          const [profile, selected] = yield* Effect.all([
            profiles.getProfile(name),
            profiles.current,
          ]);
          if (profile === undefined) {
            return yield* Effect.fail(
              new ControlNotFound({ kind: "profile", id: name }),
            );
          }
          const registered = includeProviderStatus
            ? yield* registry({ profile: name })
            : {};
          const connections = yield* Effect.forEach(
            Object.entries(profile.providers).sort(([a], [b]) =>
              a.localeCompare(b),
            ),
            ([providerName, config]) =>
              Effect.gen(function* () {
                if (!includeProviderStatus) {
                  return {
                    name: providerName,
                    method: config.method,
                    status: "connected" as const,
                    details: [],
                  };
                }
                const provider = registered[providerName];
                if (provider === undefined) {
                  return {
                    name: providerName,
                    method: config.method,
                    status: "unavailable" as const,
                    details: [],
                    diagnostic: {
                      severity: "warning" as const,
                      code: "provider.unregistered",
                      message: `Provider '${providerName}' is not registered.`,
                    },
                  };
                }
                const decoded = yield* Effect.result(
                  provider.decodeConfig(name, config),
                );
                if (Result.isFailure(decoded)) {
                  return {
                    name: providerName,
                    method: config.method,
                    status: "invalid" as const,
                    details: [],
                    diagnostic: {
                      severity: "error" as const,
                      code: "provider.invalid-config",
                      message: decoded.failure.message,
                    },
                  };
                }
                const details = yield* Effect.result(
                  provider.details(name, decoded.success),
                );
                if (Result.isSuccess(details)) {
                  return {
                    name: providerName,
                    method: config.method,
                    status: "connected" as const,
                    details: details.success.lines,
                  };
                }
                const needsReauth = Predicate.isTagged("NeedsReauth")(
                  details.failure,
                );
                return {
                  name: providerName,
                  method: config.method,
                  status: needsReauth
                    ? ("needs-reauth" as const)
                    : ("invalid" as const),
                  details: [],
                  diagnostic: {
                    severity: needsReauth
                      ? ("warning" as const)
                      : ("error" as const),
                    code: needsReauth
                      ? "provider.needs-reauth"
                      : "provider.details-failed",
                    message: details.failure.message,
                  },
                };
              }),
          );
          return {
            name,
            active: selected.name === name,
            providers: connections,
          } satisfies ProfileSnapshot;
        }),
      );

    const registry = (input: ProviderContext) =>
      collectAuthProviders({
        main: input.entrypoint ?? "alchemy.run.ts",
        envFile: Option.fromNullishOr(input.envFile),
        profile: input.profile,
      }).pipe(Effect.provide(context));

    const providers = (input: {
      readonly profile?: string;
      readonly entrypoint?: string;
      readonly envFile?: string;
    }) =>
      internalize(
        Effect.gen(function* () {
          const profile = input.profile ?? (yield* profiles.current).name;
          const stored = yield* profiles.ensureProfile(profile);
          const registered = yield* registry({ ...input, profile });
          return Object.values(registered)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((provider) => ({
              name: provider.name,
              connected: provider.name in stored.providers,
              configureMethods: (provider.configureMethods ?? []).map(
                (method) => ({
                  method: method.method,
                  label: method.method,
                  fields: method.fields.map((field) => ({
                    name: field.name,
                    label: field.label,
                    secret: field.secret ?? false,
                    required: !(field.optional ?? false),
                    description: field.description,
                    placeholder: field.placeholder,
                  })),
                }),
              ),
              supportsRefresh: true,
              supportsLogout: true,
            }));
        }),
      );

    const configure = (input: ConfigureProviderInput) =>
      Operation.make(
        (
          emit: (event: {
            readonly _tag: "ConfiguringProvider";
            readonly provider: string;
          }) => Effect.Effect<void>,
        ) =>
          internalize(
            Effect.gen(function* () {
              yield* emit({
                _tag: "ConfiguringProvider",
                provider: input.provider,
              });
              const stored = yield* profiles.ensureProfile(input.profile);
              const provider = (yield* registry(input))[input.provider];
              if (provider === undefined) {
                return yield* Effect.fail(
                  new InvalidControlInput({
                    field: "provider",
                    message: `Auth provider '${input.provider}' is not registered.`,
                  }),
                );
              }
              const connected = input.provider in stored.providers;
              if (
                (input.action === "add" && connected) ||
                (input.action === "reconfigure" && !connected)
              ) {
                return yield* Effect.fail(
                  new InvalidControlInput({
                    field: "provider",
                    message: `Provider '${input.provider}' is ${connected ? "already" : "not"} connected.`,
                  }),
                );
              }
              const config =
                input.method !== undefined &&
                input.values !== undefined &&
                provider.configureWith !== undefined
                  ? yield* provider.configureWith(input.profile, {
                      method: input.method,
                      values: Object.fromEntries(
                        Object.entries(input.values).map(([key, value]) => [
                          key,
                          Redacted.value(value),
                        ]),
                      ),
                    })
                  : yield* provider.configure(
                      input.profile,
                      connected
                        ? yield* provider
                            .decodeConfig(
                              input.profile,
                              stored.providers[input.provider]!,
                            )
                            .pipe(Effect.orElseSucceed(() => undefined))
                        : undefined,
                    );
              yield* profiles.setProfile(input.profile, {
                ...stored,
                providers: { ...stored.providers, [input.provider]: config },
              });
              return yield* get(input.profile);
            }),
          ),
      );

    const removeProvider = (
      input: ProviderContext & {
        readonly provider: string;
        readonly logout?: boolean;
      },
    ) =>
      internalize(
        Effect.gen(function* () {
          const stored = yield* profiles.ensureProfile(input.profile);
          const config = stored.providers[input.provider];
          if (config === undefined) {
            return yield* Effect.fail(
              new ControlNotFound({ kind: "provider", id: input.provider }),
            );
          }
          const provider = (yield* registry(input))[input.provider];
          let logout: "completed" | "skipped-invalid-config" | "unavailable" =
            "unavailable";
          if (provider !== undefined) {
            const decoded = yield* provider
              .decodeConfig(input.profile, config)
              .pipe(Effect.option);
            if (Option.isSome(decoded)) {
              if (input.logout ?? true)
                yield* provider.logout(input.profile, decoded.value);
              logout = "completed";
            } else logout = "skipped-invalid-config";
          }
          const { [input.provider]: _removed, ...remaining } = stored.providers;
          yield* profiles.setProfile(input.profile, {
            ...stored,
            providers: remaining,
          });
          return { profile: input.profile, provider: input.provider, logout };
        }),
      );

    const refresh = (
      input: ProviderContext & {
        readonly providers?: ReadonlyArray<string>;
      },
    ) =>
      Operation.make(
        (
          emit: (event: {
            readonly _tag: "ProviderRefreshStarted";
            readonly provider: string;
          }) => Effect.Effect<void>,
        ) =>
          internalize(
            Effect.gen(function* () {
              const stored = yield* profiles.ensureProfile(input.profile);
              const registered = yield* registry(input);
              const requested =
                input.providers === undefined || input.providers.length === 0
                  ? Object.keys(stored.providers).sort()
                  : input.providers;
              for (const name of requested) {
                const config = stored.providers[name];
                const provider = registered[name];
                if (config === undefined || provider === undefined) {
                  return yield* Effect.fail(
                    new InvalidControlInput({
                      field: "providers",
                      message: `Provider '${name}' is not connected or registered.`,
                    }),
                  );
                }
                yield* emit({ _tag: "ProviderRefreshStarted", provider: name });
                yield* provider.login(
                  input.profile,
                  yield* provider.decodeConfig(input.profile, config),
                );
              }
              return yield* get(input.profile);
            }),
          ),
      );

    return {
      list,
      current,
      get: ({ name, includeProviderStatus }: ProfileGetInput) =>
        get(name, includeProviderStatus ?? true),
      create: ({ name }: { readonly name: string }) =>
        internalize(profiles.createProfile(name)).pipe(
          Effect.andThen(get(name)),
        ),
      rename: ({
        name,
        newName,
      }: {
        readonly name: string;
        readonly newName: string;
      }) =>
        internalize(profiles.renameProfile(name, newName)).pipe(
          Effect.andThen(get(newName)),
        ),
      delete: ({ name }: { readonly name: string }) =>
        internalize(
          withProfileCredentialsLock(
            name,
            Effect.gen(function* () {
              const deleted = yield* profiles.deleteProfile(name);
              if (!deleted) {
                return yield* Effect.fail(
                  new ControlNotFound({ kind: "profile", id: name }),
                );
              }
              yield* credentials.deleteProfile(name);
              return { name, credentialsDeleted: true } as const;
            }),
          ).pipe(Effect.provide(context)),
        ),
      providers,
      configureForm: (input: {
        readonly profile: string;
        readonly provider: string;
        readonly method?: string;
      }) =>
        providers({ profile: input.profile }).pipe(
          Effect.flatMap((registered) => {
            const provider = registered.find(
              ({ name }) => name === input.provider,
            );
            return provider === undefined
              ? Effect.fail(
                  new ControlNotFound({ kind: "provider", id: input.provider }),
                )
              : Effect.succeed(
                  input.method === undefined
                    ? provider.configureMethods
                    : provider.configureMethods.filter(
                        ({ method }) => method === input.method,
                      ),
                );
          }),
        ),
      configure,
      removeProvider,
      refresh,
    };
  });

/** Profile lifecycle and provider-authentication operations. */
export class ProfileControl extends Context.Service<
  ProfileControl,
  Effect.Success<ReturnType<typeof makeProfileControl>>
>()("alchemy/AlchemyControl/Profile") {}

/** Live profile control implementation. */
export const ProfileControlLive = Layer.effect(
  ProfileControl,
  makeProfileControl(),
);
