import * as Images from "@distilled.cloud/hetzner/images";
import * as Isos from "@distilled.cloud/hetzner/isos";
import * as LoadBalancerTypes from "@distilled.cloud/hetzner/load_balancer_types";
import * as Locations from "@distilled.cloud/hetzner/locations";
import * as ServerTypes from "@distilled.cloud/hetzner/server_types";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export type CatalogKind = "location" | "serverType" | "image" | "iso" | "loadBalancerType";

export class CatalogNotFound extends Data.TaggedError("Hetzner.CatalogNotFound")<{
  kind: CatalogKind;
  ref: string;
}> {}

const numericId = (ref: string | number): number | undefined =>
  typeof ref === "number" ? ref : /^\d+$/.test(ref) ? Number(ref) : undefined;

const notFound = (kind: CatalogKind, ref: string | number) =>
  new CatalogNotFound({ kind, ref: String(ref) });

/**
 * Resolve a Hetzner Location by name (`nbg1`, `fsn1`, `hel1`, …) or
 * numeric id.
 */
export const findLocation = (ref: string | number) =>
  Effect.gen(function* () {
    const id = numericId(ref);
    if (id !== undefined) {
      const { location } = yield* Locations.getLocation({ id }).pipe(
        Effect.catchTag("NotFound", () => Effect.fail(notFound("location", ref))),
      );
      return location;
    }
    const { locations } = yield* Locations.listLocations({
      name: String(ref),
      per_page: 50,
    });
    const found = locations.find((item) => item.name === ref);
    if (found === undefined) {
      return yield* notFound("location", ref);
    }
    return found;
  });

/**
 * Resolve a Hetzner Server Type by name (`cx22`, `cpx11`, …) or numeric id.
 */
export const findServerType = (ref: string | number) =>
  Effect.gen(function* () {
    const id = numericId(ref);
    if (id !== undefined) {
      const { server_type } = yield* ServerTypes.getServerType({ id }).pipe(
        Effect.catchTag("NotFound", () => Effect.fail(notFound("serverType", ref))),
      );
      return server_type;
    }
    const { server_types } = yield* ServerTypes.listServerTypes({
      name: String(ref),
      per_page: 50,
    });
    const found = server_types.find((item) => item.name === ref);
    if (found === undefined) {
      return yield* notFound("serverType", ref);
    }
    return found;
  });

/**
 * Resolve a Hetzner Image by name (`ubuntu-24.04`, …) or numeric id.
 */
export const findImage = (ref: string | number) =>
  Effect.gen(function* () {
    const id = numericId(ref);
    if (id !== undefined) {
      const { image } = yield* Images.getImage({ id }).pipe(
        Effect.catchTag("NotFound", () => Effect.fail(notFound("image", ref))),
      );
      return image;
    }
    const { images } = yield* Images.listImages({
      name: String(ref),
      include_deprecated: true,
      per_page: 50,
    });
    const found = images.find((item) => item.name === ref);
    if (found === undefined) {
      return yield* notFound("image", ref);
    }
    return found;
  });

/**
 * Resolve a Hetzner ISO by name or numeric id.
 */
export const findIso = (ref: string | number) =>
  Effect.gen(function* () {
    const id = numericId(ref);
    if (id !== undefined) {
      const { iso } = yield* Isos.getIso({ id }).pipe(
        Effect.catchTag("NotFound", () => Effect.fail(notFound("iso", ref))),
      );
      return iso;
    }
    const { isos } = yield* Isos.listIsos({ name: String(ref), per_page: 50 });
    const found = isos.find((item) => item.name === ref);
    if (found === undefined) {
      return yield* notFound("iso", ref);
    }
    return found;
  });

/**
 * Resolve a Hetzner Load Balancer Type by name (`lb11`, `lb21`, …) or
 * numeric id.
 */
export const findLoadBalancerType = (ref: string | number) =>
  Effect.gen(function* () {
    const id = numericId(ref);
    if (id !== undefined) {
      const { load_balancer_type } = yield* LoadBalancerTypes.getLoadBalancerType({ id }).pipe(
        Effect.catchTag("NotFound", () => Effect.fail(notFound("loadBalancerType", ref))),
      );
      return load_balancer_type;
    }
    const { load_balancer_types } = yield* LoadBalancerTypes.listLoadBalancerTypes({
      name: String(ref),
      per_page: 50,
    });
    const found = load_balancer_types.find((item) => item.name === ref);
    if (found === undefined) {
      return yield* notFound("loadBalancerType", ref);
    }
    return found;
  });
