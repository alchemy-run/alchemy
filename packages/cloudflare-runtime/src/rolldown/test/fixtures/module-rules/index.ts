import font from "./font.ttf";

export default {
  fetch() {
    return Response.json({ byteLength: font.byteLength });
  },
};
