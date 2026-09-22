/**
 * Pluggable DNS validators for `AWS.ACM.Certificate`: how the certificate
 * provider publishes ACM's DNS validation CNAMEs when the domain's DNS is
 * NOT hosted in Route 53 (e.g. a Cloudflare zone).
 *
 * Mirrors `ACME/DnsSolver.ts`: a validator is a serializable
 * **descriptor** (`{ type: "Cloudflare.DNS", zone? }`) stored in the
 * certificate's props. Each DNS provider contributes a descriptor
 * constructor (`Cloudflare.DNS.AcmValidator()`) and registers the matching
 * implementation from its own `providers()` layer, so the ACM provider never
 * imports a foreign DNS SDK.
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

/** One ACM DNS validation record (`DomainValidation.ResourceRecord`). */
export interface DnsValidationRecord {
  /** Fully-qualified record name, e.g. `_abc.example.com.`. */
  readonly name: string;
  /** Record type — always `CNAME` for ACM today. */
  readonly type: string;
  /** Record value, e.g. `_xyz.acm-validations.aws.`. */
  readonly value: string;
}

/** Runtime validator. `R` is whatever context the underlying client needs. */
export interface DnsValidator<R = never> {
  /**
   * Publish every record (DNS-only, never proxied). Idempotent — records
   * that already exist with the desired value are left untouched.
   */
  readonly upsert: (
    records: ReadonlyArray<DnsValidationRecord>,
  ) => Effect.Effect<void, DnsValidatorError, R>;
}

/**
 * Serializable validator description stored in `ACM.Certificate` props.
 * `type` selects the registered implementation; the rest is provider data.
 */
export interface DnsValidatorDescriptor {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** Builds a runtime validator from a descriptor at reconcile time. */
export type DnsValidatorFactory = (
  descriptor: DnsValidatorDescriptor,
) => Effect.Effect<DnsValidator, DnsValidatorError>;

/** A DNS validator could not publish the ACM validation records. */
export class DnsValidatorError extends Data.TaggedError("DnsValidatorError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** A validator descriptor names a `type` no registered DNS provider handles. */
export class DnsValidatorNotRegistered extends Data.TaggedError(
  "DnsValidatorNotRegistered",
)<{
  readonly type: string;
}> {
  override get message() {
    return `No ACM DNS validator is registered for "${this.type}". Include the DNS provider's providers() layer (e.g. Cloudflare.providers()) in the stack.`;
  }
}

const validatorService = (type: string) =>
  Context.Service<DnsValidatorFactory>(`alchemy/AWS/ACM/DnsValidator/${type}`);

/** Resolve the registered implementation for a descriptor. */
export const resolveDnsValidator = (
  descriptor: DnsValidatorDescriptor,
): Effect.Effect<DnsValidator, DnsValidatorNotRegistered | DnsValidatorError> =>
  Effect.gen(function* () {
    const factory = yield* Effect.serviceOption(
      validatorService(descriptor.type),
    );
    if (Option.isNone(factory)) {
      return yield* new DnsValidatorNotRegistered({ type: descriptor.type });
    }
    return yield* factory.value(descriptor);
  });

/**
 * Register a validator implementation from a `providers()` layer, capturing
 * whatever services `R` the validator needs from that layer's own context so
 * the ACM provider can run it without knowing about the DNS provider.
 */
export const dnsValidatorLayer = <R>(
  type: string,
  make: (
    descriptor: DnsValidatorDescriptor,
  ) => Effect.Effect<DnsValidator<R>, DnsValidatorError>,
): Layer.Layer<DnsValidatorFactory, never, R> =>
  Layer.effect(
    validatorService(type),
    Effect.gen(function* () {
      const context = yield* Effect.context<R>();
      return (descriptor: DnsValidatorDescriptor) =>
        make(descriptor).pipe(
          Effect.map((validator): DnsValidator => ({
            upsert: (records) =>
              validator.upsert(records).pipe(Effect.provideContext(context)),
          })),
        );
    }),
  );
