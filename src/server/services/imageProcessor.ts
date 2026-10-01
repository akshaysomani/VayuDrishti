/**
 * Server-Side Image Re-Encoding & Processing Pipeline
 * ===================================================
 * 1. Strips ALL EXIF, GPS, and camera metadata completely.
 * 2. Downscales images exceeding max dimension (1600px).
 * 3. Creates an optimized thumbnail (320px).
 * 4. Computes cryptographic content hash (SHA-256) of processed image.
 * 5. Strictly ensures original uploaded binary is never served directly.
 */

import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { validateImageMagicBytes } from '../validation/imageValidator';

export interface ProcessedImageResult {
  mainBuffer: Buffer;
  thumbBuffer: Buffer;
  mimeType: string;
  ext: string;
  width: number;
  height: number;
  contentHash: string;
}

export const MAX_DIMENSION = 1600;
export const THUMB_DIMENSION = 320;
export const MIN_DIMENSION = 32;
export const MAX_INPUT_DIMENSION = 10000;

export async function processCitizenImage(
  rawBuffer: Buffer
): Promise<ProcessedImageResult> {
  // 1. Validate magic bytes before feeding to image parser
  const magicValidation = validateImageMagicBytes(rawBuffer);
  if (!magicValidation.valid) {
    throw new Error(magicValidation.error ?? 'Invalid image bytes.');
  }

  // 2. Load into Sharp and inspect metadata
  const image = sharp(rawBuffer, { failOn: 'error' });
  const meta = await image.metadata();

  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  // 3. Dimension sanity checks
  if (width < MIN_DIMENSION || height < MIN_DIMENSION) {
    throw new Error(
      `Image dimensions too small (${width}x${height}). Minimum allowed is ${MIN_DIMENSION}x${MIN_DIMENSION}px.`
    );
  }
  if (width > MAX_INPUT_DIMENSION || height > MAX_INPUT_DIMENSION) {
    throw new Error(
      `Image dimensions too large (${width}x${height}). Maximum allowed is ${MAX_INPUT_DIMENSION}x${MAX_INPUT_DIMENSION}px.`
    );
  }

  // 4. Re-encode Main Image (Stripping all metadata by NOT calling withMetadata())
  // Auto-rotates according to original orientation before stripping orientation tag
  const mainPipeline = sharp(rawBuffer)
    .rotate() // Orient correctly then strip EXIF
    .resize({
      width: MAX_DIMENSION,
      height: MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 85, mozjpeg: true });

  const mainBuffer = await mainPipeline.toBuffer();
  const mainMeta = await sharp(mainBuffer).metadata();

  // 5. Re-encode Thumbnail
  const thumbPipeline = sharp(rawBuffer)
    .rotate()
    .resize({
      width: THUMB_DIMENSION,
      height: THUMB_DIMENSION,
      fit: 'cover',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 80, mozjpeg: true });

  const thumbBuffer = await thumbPipeline.toBuffer();

  // 6. Cryptographic SHA-256 Content Hash of the normalized main image
  const contentHash = createHash('sha256').update(mainBuffer).digest('hex');

  return {
    mainBuffer,
    thumbBuffer,
    mimeType: 'image/jpeg',
    ext: '.jpg',
    width: mainMeta.width ?? width,
    height: mainMeta.height ?? height,
    contentHash,
  };
}
