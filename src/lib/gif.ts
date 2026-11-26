// Reading a GIF's blocks, without decoding it, so it runs anywhere (the service worker, and the unit tests).
// The same counter as the web client's src/gif.ts.

/**
 * How many pictures a GIF holds, by walking its blocks (no decoding): 1 for a still GIF, more for an animation, 0 when
 * the bytes are not a GIF. Saving turns an image into one still picture (the browser draws one frame), so a GIF with
 * more than one is told so (QA #87).
 */
export function gifFrames(b: Uint8Array): number {
  const at = (n: number): number => b[n] ?? 0;
  if (b.length < 13 || at(0) !== 0x47 || at(1) !== 0x49 || at(2) !== 0x46) return 0;
  let i = 13;
  if (at(10) & 0x80) i += 3 * 2 ** ((at(10) & 7) + 1);
  const skip = () => {
    while (i < b.length && at(i) !== 0) i += at(i) + 1;
    i++;
  };
  let frames = 0;
  while (i < b.length) {
    const block = at(i++);
    if (block === 0x3b) break;
    if (block === 0x21) {
      i++;
      skip();
    } else if (block === 0x2c) {
      frames++;
      const flags = at(i + 8);
      i += 9;
      if (flags & 0x80) i += 3 * 2 ** ((flags & 7) + 1);
      i++;
      skip();
    } else break;
  }
  return frames;
}
