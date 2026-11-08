import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const BYTES_PER_PIXEL = 4;

export class ImageBudgetError extends Error {
  constructor({ width, height, requiredBytes, maxBytes }) {
    super(
      `Image ${width}x${height} needs roughly ${requiredBytes} bytes, above the ${maxBytes}-byte budget. ` +
        "raise --max-image-bytes or compare smaller viewports; no comparison was attempted.",
    );
    this.name = "ImageBudgetError";
    this.code = "IMAGE_MEMORY_BUDGET";
    this.width = width;
    this.height = height;
    this.requiredBytes = requiredBytes;
    this.maxBytes = maxBytes;
  }
}

/** Read PNG dimensions from IHDR before decoding any pixel data. */
export function readPngHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) throw new Error("Not a PNG buffer: too short.");
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("Not a PNG buffer: bad signature.");
  if (buffer.toString("ascii", 12, 16) !== "IHDR") throw new Error("Not a PNG buffer: missing IHDR.");
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) throw new Error("Invalid PNG dimensions.");
  return { width, height };
}

/** Peak estimate: source, clone, two padded union canvases, and the diff mask. */
export function estimateImageMemory({ width, height }, copies = 4) {
  return Math.ceil(width * height * BYTES_PER_PIXEL * copies);
}

function decode(buffer, label) {
  const header = readPngHeader(buffer);
  return { header, image: PNG.sync.read(buffer, { skipRescale: false }), label };
}

/**
 * Compare two PNG screenshots with an incremental bounding box. The previous
 * implementation pushed every changed coordinate into arrays and spread them
 * into Math.min/Math.max, which throws for large full-page captures.
 */
export function compareScreenshots(sourceBuffer, cloneBuffer, options = {}) {
  const {
    threshold = 0.1,
    includeAA = false,
    maxBytes = DEFAULT_MAX_BYTES,
    tileSize = 64,
    maxRegions = 5,
  } = options;

  const sourceHeader = readPngHeader(sourceBuffer);
  const cloneHeader = readPngHeader(cloneBuffer);
  const width = Math.max(sourceHeader.width, cloneHeader.width);
  const height = Math.max(sourceHeader.height, cloneHeader.height);
  const requiredBytes = estimateImageMemory({ width, height });
  if (requiredBytes > maxBytes) {
    throw new ImageBudgetError({ width, height, requiredBytes, maxBytes });
  }

  const source = decode(sourceBuffer, "source");
  const clone = decode(cloneBuffer, "clone");
  const sourceCanvas = new PNG({ width, height });
  const cloneCanvas = new PNG({ width, height });
  const diff = new PNG({ width, height });
  PNG.bitblt(source.image, sourceCanvas, 0, 0, source.image.width, source.image.height, 0, 0);
  PNG.bitblt(clone.image, cloneCanvas, 0, 0, clone.image.width, clone.image.height, 0, 0);

  const changedPixels = pixelmatch(sourceCanvas.data, cloneCanvas.data, diff.data, width, height, {
    threshold,
    includeAA,
    diffMask: true,
  });

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  const columns = Math.ceil(width / tileSize);
  const rows = Math.ceil(height / tileSize);
  const tiles = new Uint32Array(columns * rows);

  for (let index = 0; index < diff.width * diff.height; index += 1) {
    if (diff.data[index * 4 + 3] === 0) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    tiles[Math.floor(y / tileSize) * columns + Math.floor(x / tileSize)] += 1;
  }

  const regions = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const count = tiles[row * columns + column];
      if (!count) continue;
      regions.push({
        x: column * tileSize,
        y: row * tileSize,
        width: Math.min(tileSize, width - column * tileSize),
        height: Math.min(tileSize, height - row * tileSize),
        changedPixels: count,
      });
    }
  }
  regions.sort((left, right) => right.changedPixels - left.changedPixels);

  return {
    missing: false,
    width,
    height,
    changedPixels,
    totalPixels: width * height,
    changeRatio: changedPixels / (width * height),
    dimensionMismatch: sourceImageDimensionMismatch(source.image, clone.image),
    largestDifferenceRegion: maxX >= 0 ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
    regions: regions.slice(0, maxRegions),
    diffPng: PNG.sync.write(diff),
  };
}

function sourceImageDimensionMismatch(left, right) {
  return left.width !== right.width || left.height !== right.height;
}

/** Missing clone screenshots are a failure, never an implicit pass. */
export function missingScreenshot(sourceBuffer) {
  const { width, height } = readPngHeader(sourceBuffer);
  return {
    missing: true,
    changedPixels: width * height,
    totalPixels: width * height,
    changeRatio: 1,
    dimensionMismatch: true,
    largestDifferenceRegion: { x: 0, y: 0, width, height },
    regions: [],
    error: { code: "MISSING_CLONE_SCREENSHOT", message: "Clone screenshot is missing." },
  };
}
