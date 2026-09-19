/**
 * Deterministic 4096x2048 grayscale equirectangular JPEG with Photo
 * Sphere XMP metadata, generated once as a constant (not at test time
 * with random data).
 */

const WIDTH = 4096;
const HEIGHT = 2048;

const XMP = [
  '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>',
  '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
  '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
  '<rdf:Description rdf:about="" xmlns:GPano="http://ns.google.com/photos/1.0/panorama/"',
  ' GPano:ProjectionType="equirectangular"',
  ' GPano:UsePanoramaViewer="True"',
  ' GPano:CaptureSoftware="Alchemy"',
  ' GPano:StitchingSoftware="Alchemy"',
  ` GPano:FullPanoWidthPixels="${WIDTH}"`,
  ` GPano:FullPanoHeightPixels="${HEIGHT}"`,
  ' GPano:CroppedAreaLeftPixels="0"',
  ' GPano:CroppedAreaTopPixels="0"',
  ` GPano:CroppedAreaImageWidthPixels="${WIDTH}"`,
  ` GPano:CroppedAreaImageHeightPixels="${HEIGHT}"`,
  ' GPano:PoseHeadingDegrees="0"/>',
  "</rdf:RDF>",
  "</x:xmpmeta>",
  '<?xpacket end="w"?>',
].join("");

class BitWriter {
  readonly bytes: number[] = [];
  private acc = 0;
  private n = 0;

  write(code: number, length: number) {
    for (let i = length - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((code >> i) & 1);
      this.n++;
      if (this.n === 8) this.flushByte();
    }
  }

  finish() {
    if (this.n > 0) {
      this.acc = (this.acc << (8 - this.n)) | ((1 << (8 - this.n)) - 1);
      this.n = 8;
      this.flushByte();
    }
    return Uint8Array.from(this.bytes);
  }

  private flushByte() {
    this.bytes.push(this.acc & 0xff);
    if ((this.acc & 0xff) === 0xff) this.bytes.push(0x00);
    this.acc = 0;
    this.n = 0;
  }
}

const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];

const utf8 = (value: string) => new TextEncoder().encode(value);

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const app1 = (payload: string) => {
  const header = utf8("http://ns.adobe.com/xap/1.0/\0");
  const xml = utf8(payload);
  const length = 2 + header.length + xml.length;
  return Uint8Array.from([0xff, 0xe1, ...u16(length), ...header, ...xml]);
};

const makeJpeg = (): Uint8Array => {
  const soi = [0xff, 0xd8];
  const app0 = [
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
    0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ];
  const dqt = [
    0xff,
    0xdb,
    0x00,
    0x43,
    0x00,
    ...Array.from({ length: 64 }, () => 1),
  ];
  const sof0 = [
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    ...u16(HEIGHT),
    ...u16(WIDTH),
    0x01,
    0x01,
    0x11,
    0x00,
  ];
  // Custom Huffman: DC category 0 -> "0"; AC EOB (0x00) -> "1".
  const dhtDc = [
    0xff,
    0xc4,
    0x00,
    0x14,
    0x00,
    0x01,
    ...Array(15).fill(0),
    0x00,
  ];
  const dhtAc = [
    0xff,
    0xc4,
    0x00,
    0x14,
    0x10,
    0x01,
    ...Array(15).fill(0),
    0x00,
  ];
  const sos = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00];
  const writer = new BitWriter();
  const mcus = Math.ceil(WIDTH / 8) * Math.ceil(HEIGHT / 8);
  for (let i = 0; i < mcus; i++) {
    writer.write(0, 1);
    writer.write(1, 1);
  }
  const scan = writer.finish();
  const eoi = [0xff, 0xd9];
  return Uint8Array.from([
    ...soi,
    ...app1(XMP),
    ...app0,
    ...dqt,
    ...sof0,
    ...dhtDc,
    ...dhtAc,
    ...sos,
    ...scan,
    ...eoi,
  ]);
};

export const EQUIRECTANGULAR_JPEG = makeJpeg();

export const EQUIRECTANGULAR_JPEG_BASE64 = toBase64(EQUIRECTANGULAR_JPEG);

/** Tiny ftyp+mdat MP4 used only as upload bytes for photo sequences. */
export const MINIMAL_MP4 = Uint8Array.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0x00,
  0x00, 0x00, 0x00, 0x6d, 0x70, 0x34, 0x32, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00,
  0x00, 0x08, 0x6d, 0x64, 0x61, 0x74,
]);

export const MINIMAL_MP4_BASE64 = toBase64(MINIMAL_MP4);
