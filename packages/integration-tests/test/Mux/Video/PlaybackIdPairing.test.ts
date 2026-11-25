import { playbackIdChanges } from "@alchemy.run/mux/internal/converge";
import { expect, test } from "@alchemy.run/test";

// A Mux test environment has no DRM configuration, so the pairing rule
// Asset uses for playback IDs is checked here rather than live.
const drmA = { policy: "drm", drm_configuration_id: "cfg-a" };
const drmB = { policy: "drm", drm_configuration_id: "cfg-b" };

test("a DRM playback ID with another configuration is replaced", () => {
  const { create, remove } = playbackIdChanges([drmA], [{ id: "x", ...drmB }]);
  expect(create).toEqual([drmA]);
  expect(remove.map((p) => p.id)).toEqual(["x"]);
});

test("a second DRM playback ID for one configuration is removed", () => {
  const { create, remove } = playbackIdChanges(
    [drmA],
    [
      { id: "x", ...drmA },
      { id: "y", ...drmA },
    ],
  );
  expect(create).toEqual([]);
  expect(remove.map((p) => p.id)).toEqual(["y"]);
});

test("a missing policy is created and a repeated one is paired once", () => {
  const missing = playbackIdChanges(
    [{ policy: "public" }, { policy: "signed" }],
    [{ id: "p", policy: "public" }],
  );
  expect(missing.create).toEqual([{ policy: "signed" }]);
  expect(missing.remove).toEqual([]);
  const repeated = playbackIdChanges(
    [{ policy: "public" }, { policy: "public" }],
    [{ id: "p", policy: "public" }],
  );
  expect(repeated.create).toEqual([{ policy: "public" }]);
  expect(repeated.remove).toEqual([]);
});
