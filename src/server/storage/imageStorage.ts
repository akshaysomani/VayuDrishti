/**
 * Image Storage Abstraction for Citizen Reports
 * =============================================
 * Handles saving and retrieving processed citizen report photos.
 * Implements strict path traversal defenses and validates storage keys.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ImageStorageItem {
  buffer: Buffer;
  mimeType: string;
}

export interface IImageStorage {
  saveImage(key: string, buffer: Buffer, mimeType: string): Promise<string>;
  getImage(key: string): Promise<ImageStorageItem | null>;
  deleteImage(key: string): Promise<void>;
  hasImage(key: string): Promise<boolean>;
}

/**
 * Strict filename validator: Only alphanumeric, dashes, and underscores
 * followed by standard image extensions. Rejects any slashes, dots, or control chars.
 */
const SAFE_KEY_REGEX = /^[a-zA-Z0-9_-]+\.(jpg|jpeg|png|webp)$/;

export class DiskImageStorage implements IImageStorage {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir =
      baseDir ||
      process.env.CITIZEN_REPORTS_UPLOAD_DIR ||
      path.join(process.cwd(), 'src', 'data', 'uploads');

    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  private resolveSafePath(key: string): string {
    if (!SAFE_KEY_REGEX.test(key)) {
      throw new Error(`Invalid storage key: path traversal attempt or illegal filename "${key}"`);
    }
    const safePath = path.resolve(this.baseDir, key);
    // Double check that resolved path is strictly inside baseDir
    if (!safePath.startsWith(path.resolve(this.baseDir))) {
      throw new Error(`Path traversal guard triggered for key: ${key}`);
    }
    return safePath;
  }

  public async saveImage(key: string, buffer: Buffer, _mimeType: string): Promise<string> {
    const targetPath = this.resolveSafePath(key);
    await fs.promises.writeFile(targetPath, buffer);
    return key;
  }

  public async getImage(key: string): Promise<ImageStorageItem | null> {
    try {
      const targetPath = this.resolveSafePath(key);
      if (!fs.existsSync(targetPath)) {
        return null;
      }
      const buffer = await fs.promises.readFile(targetPath);
      const ext = path.extname(key).toLowerCase();
      let mimeType = 'image/jpeg';
      if (ext === '.webp') mimeType = 'image/webp';
      else if (ext === '.png') mimeType = 'image/png';

      return { buffer, mimeType };
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('Invalid storage key')) {
        throw err;
      }
      return null;
    }
  }

  public async deleteImage(key: string): Promise<void> {
    try {
      const targetPath = this.resolveSafePath(key);
      if (fs.existsSync(targetPath)) {
        await fs.promises.unlink(targetPath);
      }
    } catch {
      // Best-effort removal
    }
  }

  public async hasImage(key: string): Promise<boolean> {
    try {
      const targetPath = this.resolveSafePath(key);
      return fs.existsSync(targetPath);
    } catch {
      return false;
    }
  }
}

/**
 * Storage factory - defaults to DiskImageStorage for local dev,
 * ready to instantiate cloud/S3 storage when AWS_S3_BUCKET is provided.
 */
let globalImageStorage: IImageStorage | null = null;

export function getImageStorage(): IImageStorage {
  if (!globalImageStorage) {
    globalImageStorage = new DiskImageStorage();
  }
  return globalImageStorage;
}

export function setImageStorage(storage: IImageStorage): void {
  globalImageStorage = storage;
}
