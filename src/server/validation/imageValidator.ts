/**
 * Image Magic-Bytes and Format Validation
 * ========================================
 * Validates images strictly by header byte signatures (magic bytes)
 * rather than trusting user-supplied file extensions or Content-Type headers.
 * Explicitly rejects SVG, HTML, scripts, executables, and malformed files.
 */

export type AllowedImageFormat = 'jpeg' | 'png' | 'webp';

export interface MagicByteValidationResult {
  valid: boolean;
  format: AllowedImageFormat | null;
  error?: string;
}

/**
 * Validates the file buffer by magic bytes.
 * - JPEG: FF D8 FF
 * - PNG: 89 50 4E 47 0D 0A 1A 0A
 * - WebP: RIFF (bytes 0..3) ... WEBP (bytes 8..11)
 */
export function validateImageMagicBytes(buffer: Buffer): MagicByteValidationResult {
  if (!buffer || buffer.length === 0) {
    return { valid: false, format: null, error: 'Empty file buffer (0 bytes).' };
  }

  // Minimum header size to detect signatures
  if (buffer.length < 12) {
    return { valid: false, format: null, error: 'File header too small to be a valid image.' };
  }

  // Check for SVG / XML / HTML text signatures explicitly first
  const headAscii = buffer.subarray(0, Math.min(buffer.length, 512)).toString('utf8').toLowerCase();
  if (
    headAscii.includes('<svg') ||
    headAscii.includes('<?xml') ||
    headAscii.includes('<!doctype html') ||
    headAscii.includes('<html') ||
    headAscii.includes('<script')
  ) {
    return {
      valid: false,
      format: null,
      error: 'Vector graphics (SVG) and script/markup documents are strictly disallowed for security reasons.',
    };
  }

  // Check JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { valid: true, format: 'jpeg' };
  }

  // Check PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { valid: true, format: 'png' };
  }

  // Check WebP: RIFF (0..3) + WEBP (8..11)
  if (
    buffer[0] === 0x52 && // 'R'
    buffer[1] === 0x49 && // 'I'
    buffer[2] === 0x46 && // 'F'
    buffer[3] === 0x46 && // 'F'
    buffer[8] === 0x57 && // 'W'
    buffer[9] === 0x45 && // 'E'
    buffer[10] === 0x42 && // 'B'
    buffer[11] === 0x50 // 'P'
  ) {
    return { valid: true, format: 'webp' };
  }

  return {
    valid: false,
    format: null,
    error: 'Unsupported image type. Only genuine JPEG, PNG, and WebP raster images are accepted.',
  };
}

/**
 * Text content sanitization for descriptions.
 * Strips HTML tags and script elements to eliminate stored XSS.
 * Stores raw-validated text (max 500 characters); escaping is handled
 * at render time by React to avoid double-escaped entities in the UI.
 */
export function sanitizeDescription(input?: string): string {
  if (!input) return '';
  // 1. Cap length at 500 characters
  let clean = input.slice(0, 500);

  // 2. Strip all HTML tags
  clean = clean.replace(/<[^>]*>/g, '');

  return clean.trim();
}
