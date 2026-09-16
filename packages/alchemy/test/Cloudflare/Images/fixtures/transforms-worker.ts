/// <reference types="@cloudflare/workers-types" />
import { ABEL_FONT } from "./abel-font.ts";
const animated =
  "R0lGODlhBAACAIAAAExpcf8AACH/C05FVFNDQVBFMi4wAwEBAAAh+QQFCgAAACwAAAAABAACAAACA4xvBQAh+QQFFAAAACwAAAAABAACAIBMaXEAAP8CA4xvBQA7";
const red =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVR4nGP4z8CAFWEXJUsCAFpeH+EeQoQoAAAAAElFTkSuQmCC";
const blue = "R0lGODlhBAAEAIAAAExpcQAA/yH5BAUAAAAALAAAAAAEAAQAAAIEjI8ZBQA7";
const bytes = (value: string) =>
  new Blob([Uint8Array.from(atob(value), (c) => c.charCodeAt(0))]).stream();
export default {
  async fetch(request: Request, env: { IMAGES: ImagesBinding }) {
    if (new URL(request.url).pathname === "/font")
      return new Response(bytes(ABEL_FONT), {
        headers: { "content-type": "font/ttf" },
      });
    const params = (await request.json()) as {
      source?: "text" | "animated";
      size?: number;
      textDraw?: boolean;
      transforms?: ImageTransform[];
      output?: ImageOutputOptions;
      draw?: boolean;
    };
    const text = () =>
      env.IMAGES.text("Abel <&>", {
        font: { url: new URL("/font", request.url).toString() },
        size: params.size ?? 20,
        color: "lime",
      });
    let image =
      params.source === "text"
        ? text()
        : env.IMAGES.input(
            bytes(params.source === "animated" ? animated : red),
          );
    for (const transform of params.transforms ?? [])
      image = image.transform(transform);
    if (params.draw)
      image = image.draw(
        env.IMAGES.input(bytes(blue)).transform({ width: 2, height: 2 }),
        { left: 1, top: 1 },
      );
    if (params.textDraw)
      image = image.draw(text().transform({ width: 4 }), { left: 0, top: 0 });
    return (
      await image.output(params.output ?? { format: "image/png" })
    ).response();
  },
};
