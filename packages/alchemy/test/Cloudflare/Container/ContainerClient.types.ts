import * as Cloudflare from "@/Cloudflare";
import type { InputProps } from "@/Input.ts";
import type { Output } from "@/Output.ts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type ImagesOf<T> =
  T extends Effect.Effect<
    Cloudflare.Containers.ContainerClient<infer Name>,
    infer _E,
    infer _R
  >
    ? Effect.Success<Cloudflare.Containers.ContainerClient<Name>["images"]>
    : never;

class Sandbox extends Cloudflare.Container<Sandbox>()("SandboxTypes", {
  schedulingPolicy: "durable_object",
  images: {
    shell: { image: "alpine:3.21" },
    node: { image: "node:22-slim" },
  },
}) {}

const sandbox = Cloudflare.Containers.bind(Sandbox);
type _ClassImageNames = Assert<
  Equal<ImagesOf<typeof sandbox>, Readonly<Record<"shell" | "node", string>>>
>;

const direct = Cloudflare.Containers.bind(
  Cloudflare.Container("DirectTypes", {
    schedulingPolicy: "durable_object",
    images: { shell: { image: "alpine:3.21" } },
  }),
);
type _DirectImageNames = Assert<
  Equal<ImagesOf<typeof direct>, Readonly<Record<"shell", string>>>
>;

class ImageSource extends Context.Service<ImageSource, { image: string }>()(
  "container/types/ImageSource",
) {}

class Effectful extends Cloudflare.Container<Effectful>()(
  "EffectfulTypes",
  Effect.gen(function* () {
    const { image } = yield* ImageSource;
    return { schedulingPolicy: "durable_object", images: { shell: { image } } };
  }),
) {}

const effectful = Cloudflare.Containers.bind(Effectful);
type _EffectImageNames = Assert<
  Equal<ImagesOf<typeof effectful>, Readonly<Record<"shell", string>>>
>;
type _PreservesPropsRequirements = Assert<
  Equal<Extract<Effect.Services<typeof effectful>, ImageSource>, ImageSource>
>;

const config = Cloudflare.Containers.bind(
  Cloudflare.Container("ConfigTypes", {
    schedulingPolicy: "durable_object",
    images: Config.succeed({ shell: { image: "alpine:3.21" } }),
  }),
);
type _ConfigImageNames = Assert<
  Equal<ImagesOf<typeof config>, Readonly<Record<"shell", string>>>
>;

const output = (
  images: Output<{ shell: Cloudflare.Containers.ContainerImageProps }>,
) =>
  Cloudflare.Containers.bind(
    Cloudflare.Container("OutputTypes", {
      schedulingPolicy: "durable_object",
      images,
    }),
  );
type _OutputImageNames = Assert<
  Equal<ImagesOf<ReturnType<typeof output>>, Readonly<Record<"shell", string>>>
>;

const dynamic = (
  images: Record<string, Cloudflare.Containers.ContainerImageProps>,
) =>
  Cloudflare.Containers.bind(
    Cloudflare.Container("DynamicTypes", {
      schedulingPolicy: "durable_object",
      images,
    }),
  );
type _DynamicImagesMayBeMissing = Assert<
  Equal<
    ImagesOf<ReturnType<typeof dynamic>>,
    Readonly<Record<string, string | undefined>>
  >
>;

const optional = (
  props: InputProps<Cloudflare.Containers.DurableObjectContainerProps>,
) => Cloudflare.Containers.bind(Cloudflare.Container("OptionalTypes", props));
type _OptionalImagesMayBeMissing = Assert<
  Equal<
    ImagesOf<ReturnType<typeof optional>>,
    Readonly<Record<string, string | undefined>>
  >
>;

const optionalKey = (images: {
  shell?: Cloudflare.Containers.ContainerImageProps;
}) =>
  Cloudflare.Containers.bind(
    Cloudflare.Container("OptionalKeyTypes", {
      schedulingPolicy: "durable_object",
      images,
    }),
  );
type _OptionalImageKeyMayBeMissing = Assert<
  Equal<
    ImagesOf<ReturnType<typeof optionalKey>>,
    Readonly<Record<string, string | undefined>>
  >
>;

const noImages = Cloudflare.Containers.bind(
  Cloudflare.Container("NoImageTypes", { schedulingPolicy: "durable_object" }),
);
type _OmittedImagesMayBeMissing = Assert<
  Equal<ImagesOf<typeof noImages>, Readonly<Record<string, string | undefined>>>
>;

export const imageTypes = Effect.gen(function* () {
  const client = yield* sandbox;
  const images = yield* client.images;
  yield* client.start({ image: images.shell, enableInternet: false });
  // @ts-expect-error Only declared image names are available.
  images.shel;

  const dynamicClient = yield* dynamic({});
  // @ts-expect-error An arbitrary image name may be absent.
  const missing: string = (yield* dynamicClient.images).shell;
  void missing;
});
