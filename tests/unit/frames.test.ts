// QA #87 (ruling 2026-11-28): how many pictures an APNG or a WebP holds, counted from the file's bytes, with the same
// cases as the web client's counter.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imageFrames, pngFrames, webpFrames } from '../../src/lib/frames.ts';

// Made-up files, as much of each as counting reads: the pictures themselves are not needed, only the chunks around them.
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const zeros = (n: number) => Array<number>(n).fill(0);

// PNG: signature, then chunks of length, type, data and a checksum (which counting does not read).
const png = (...chunks: number[][]) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunks.flat()]);
const pngChunk = (type: string, data: number[]) => [...be32(data.length), ...ascii(type), ...data, 0, 0, 0, 0];
const IHDR = pngChunk('IHDR', [...be32(96), ...be32(64), 8, 6, 0, 0, 0]);
const IDAT = pngChunk('IDAT', [0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]);
const IEND = pngChunk('IEND', []);
const acTL = (frames: number) => pngChunk('acTL', [...be32(frames), ...be32(0)]);
const fcTL = (n: number) => pngChunk('fcTL', [...be32(n), ...zeros(22)]);
const fdAT = (n: number) => pngChunk('fdAT', [...be32(n), 0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]);
const apng = (frames: number) => png(IHDR, acTL(frames), fcTL(0), IDAT, ...Array.from({ length: frames - 1 }, (_, k) => [...fcTL(2 * k + 1), ...fdAT(2 * k + 2)]), IEND);

// WebP: "RIFF", the size, "WEBP", then chunks of type, length (little-endian), data, and a byte more when the data is odd.
const webpChunk = (type: string, data: number[]) => [...ascii(type), ...le32(data.length), ...data, ...(data.length % 2 ? [0] : [])];
const riff = (...chunks: number[][]) => {
  const body = [...ascii('WEBP'), ...chunks.flat()];
  return new Uint8Array([...ascii('RIFF'), ...le32(body.length), ...body]);
};
const VP8X = (flags: number) => webpChunk('VP8X', [flags, 0, 0, 0, 95, 0, 0, 63, 0, 0]);
const VP8L = webpChunk('VP8L', [0x2f, 0, 0, 0, 0x10, 0x07, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe, 0x07, 0x00]);
const ANIM = webpChunk('ANIM', [...zeros(4), 0, 0]);
const ANMF = webpChunk('ANMF', [...zeros(6), 95, 0, 0, 63, 0, 0, 100, 0, 0, 0, ...VP8L]);
const animatedWebp = (frames: number) => riff(VP8X(0x02), ANIM, ...Array.from({ length: frames }, () => ANMF));

const gif = (n: number) => {
  const header = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00];
  const frame = [0x21, 0xf9, 0x04, 0x01, 0x0a, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00];
  return new Uint8Array([...header, ...Array.from({ length: n }, () => frame).flat(), 0x3b]);
};

test('an APNG with two frames is 2, and the acTL count for more', () => {
  assert.equal(pngFrames(apng(2)), 2);
  assert.equal(pngFrames(apng(5)), 5);
});

test('a still PNG is 1, and so is an APNG that says it has one frame', () => {
  assert.equal(pngFrames(png(IHDR, IDAT, IEND)), 1);
  assert.equal(pngFrames(png(IHDR, acTL(1), fcTL(0), IDAT, IEND)), 1);
  assert.equal(pngFrames(png(IHDR, acTL(0), IDAT, IEND)), 1);
});

test('an acTL after the picture is not an animation (the format puts it before the first IDAT)', () => {
  assert.equal(pngFrames(png(IHDR, IDAT, acTL(2), IEND)), 1);
});

test('a cut PNG is not run off, and bytes that are not a PNG are 0', () => {
  assert.equal(pngFrames(apng(3).slice(0, 8 + IHDR.length + 10)), 1);
  assert.equal(pngFrames(apng(3).slice(0, 8 + IHDR.length + 8 + 4)), 1);
  assert.equal(pngFrames(new Uint8Array()), 0);
  assert.equal(pngFrames(new TextEncoder().encode('%PDF-1.7 hello, not a picture')), 0);
  assert.equal(pngFrames(animatedWebp(2)), 0);
});

test('an animated WebP is the number of its ANMF chunks', () => {
  assert.equal(webpFrames(animatedWebp(2)), 2);
  assert.equal(webpFrames(animatedWebp(6)), 6);
});

test('a still WebP is 1, lossy or lossless, with or without a VP8X header', () => {
  assert.equal(webpFrames(riff(webpChunk('VP8 ', zeros(10)))), 1);
  assert.equal(webpFrames(riff(VP8L)), 1);
  // VP8X without the animation flag: colour profile (0x20), alpha (0x10), metadata (0x08, 0x04) are still pictures.
  for (const flags of [0x00, 0x10, 0x20, 0x08, 0x04, 0x3c]) assert.equal(webpFrames(riff(VP8X(flags), VP8L)), 1);
});

test('the flag decides: ANMF chunks under a header without it are not an animation, one frame under it is not either', () => {
  assert.equal(webpFrames(riff(VP8X(0x10), ANMF, ANMF)), 1);
  assert.equal(webpFrames(riff(VP8X(0x02), ANIM, ANMF)), 1);
});

test('a WebP chunk of odd size does not hide the frames after it', () => {
  const exif = webpChunk('EXIF', [1, 2, 3, 4, 5]);
  assert.equal(webpFrames(riff(VP8X(0x0a), ANIM, exif, ANMF, ANMF)), 2);
  assert.equal(webpFrames(riff(VP8X(0x02), webpChunk('ANIM', [0, 0, 0, 0, 0, 0, 7]), ANMF, ANMF, ANMF)), 3);
});

test('a cut WebP is not run off, and bytes that are not a WebP are 0', () => {
  const cut = animatedWebp(3).slice(0, 12 + VP8X(2).length + ANIM.length + ANMF.length + 12);
  assert.equal(webpFrames(cut), 2);
  assert.equal(webpFrames(animatedWebp(3).slice(0, 14)), 1);
  assert.equal(webpFrames(new Uint8Array()), 0);
  assert.equal(webpFrames(new Uint8Array([...ascii('RIFF'), ...le32(4), ...ascii('WAVE')])), 0);
  assert.equal(webpFrames(apng(2)), 0);
});

test('imageFrames tells a GIF, an APNG and a WebP by their bytes: two frames is two, a still picture is one', () => {
  assert.equal(imageFrames(gif(2)), 2);
  assert.equal(imageFrames(apng(2)), 2);
  assert.equal(imageFrames(animatedWebp(2)), 2);
  assert.equal(imageFrames(gif(1)), 1);
  assert.equal(imageFrames(png(IHDR, IDAT, IEND)), 1);
  assert.equal(imageFrames(riff(VP8X(0x10), VP8L)), 1);
});

test('imageFrames is 0 for a JPEG, a PDF, text and nothing', () => {
  assert.equal(imageFrames(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0])), 0);
  assert.equal(imageFrames(new TextEncoder().encode('%PDF-1.7 hello')), 0);
  assert.equal(imageFrames(new TextEncoder().encode('A few made-up words.')), 0);
  assert.equal(imageFrames(new Uint8Array()), 0);
});
