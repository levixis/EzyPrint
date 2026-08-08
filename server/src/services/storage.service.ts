import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env';
import { ApiError } from '../utils/ApiError';

/**
 * Storage Service — abstracted file storage layer.
 *
 * Supports two modes:
 * 1. 'local' — Files saved to disk at `server/uploads/`. Good for dev.
 * 2. 's3'    — Files uploaded to S3/Cloudflare R2. For production.
 *
 * Both modes expose the same interface, making it trivial to switch
 * between dev and prod without changing any business logic.
 *
 * Interview talking point: "I implemented the Strategy Pattern for storage —
 * local filesystem for development, S3 for production. The service layer
 * doesn't know or care which one is active."
 */

// ── S3 Client (lazy-initialized) ──
let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (!s3Client) {
    if (!env.S3_ACCESS_KEY || !env.S3_SECRET_KEY || !env.S3_BUCKET) {
      throw ApiError.internal('S3 storage is not configured. Set S3_* env vars.');
    }

    s3Client = new S3Client({
      region: env.S3_REGION,
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY,
        secretAccessKey: env.S3_SECRET_KEY,
      },
      // Required for R2 compatibility
      forcePathStyle: !!env.S3_ENDPOINT,
    });
  }
  return s3Client;
}

// ── Helpers ──

/**
 * Generate a unique storage key to prevent filename collisions.
 * Format: <folder>/<timestamp>-<random>-<original-name>
 */
function generateStorageKey(originalName: string, folder: string = 'orders'): string {
  const timestamp = Date.now();
  const randomId = crypto.randomBytes(8).toString('hex');
  const sanitized = originalName.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 100);
  return `${folder}/${timestamp}-${randomId}-${sanitized}`;
}

/**
 * Get the local upload directory path (creates it if needed).
 */
async function getLocalUploadDir(): Promise<string> {
  const uploadDir = path.resolve(__dirname, '../../', env.LOCAL_UPLOAD_DIR);
  await fs.mkdir(uploadDir, { recursive: true });
  return uploadDir;
}

// ────────────────────────────────────────────────────────────
// UPLOAD
// ────────────────────────────────────────────────────────────

export interface UploadResult {
  storageKey: string;   // The unique key/path in storage
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  mode: 'local' | 's3';
}

/**
 * Upload a file buffer to storage.
 */
export async function uploadFile(
  buffer: Buffer,
  originalName: string,
  mimeType: string,
  folder?: string
): Promise<UploadResult> {
  const storageKey = generateStorageKey(originalName, folder);

  if (env.STORAGE_MODE === 's3') {
    await uploadToS3(storageKey, buffer, mimeType);
  } else {
    await uploadToLocal(storageKey, buffer);
  }

  return {
    storageKey,
    originalName,
    mimeType,
    sizeBytes: buffer.length,
    mode: env.STORAGE_MODE,
  };
}

async function uploadToS3(key: string, buffer: Buffer, mimeType: string): Promise<void> {
  const client = getS3Client();
  await client.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
    })
  );
}

async function uploadToLocal(key: string, buffer: Buffer): Promise<void> {
  const uploadDir = await getLocalUploadDir();
  const filePath = path.join(uploadDir, key);

  // Create subdirectories (e.g., uploads/orders/)
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, buffer);
}

// ────────────────────────────────────────────────────────────
// DOWNLOAD (pre-signed URL or local path)
// ────────────────────────────────────────────────────────────

export interface DownloadInfo {
  url: string;
  mode: 'local' | 's3';
  expiresIn?: number; // seconds (only for S3 pre-signed URLs)
}

/**
 * Get a download URL for a file.
 * - S3: Returns a pre-signed URL (expires in 1 hour).
 * - Local: Returns the local API endpoint path.
 */
export async function getDownloadUrl(storageKey: string): Promise<DownloadInfo> {
  if (env.STORAGE_MODE === 's3') {
    const client = getS3Client();
    const expiresIn = 3600; // 1 hour

    const url = await getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: storageKey,
      }),
      { expiresIn }
    );

    return { url, mode: 's3', expiresIn };
  }

  // Local mode — return API path (served by Express static or download route)
  return {
    url: `/api/v1/uploads/download/${encodeURIComponent(storageKey)}`,
    mode: 'local',
  };
}

/**
 * Get the raw file buffer from storage (for streaming/serving locally).
 */
export async function getFileBuffer(storageKey: string): Promise<Buffer> {
  if (env.STORAGE_MODE === 's3') {
    const client = getS3Client();
    const response = await client.send(
      new GetObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: storageKey,
      })
    );

    if (!response.Body) {
      throw ApiError.notFound('File not found in S3');
    }

    // Convert stream to buffer
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  // Local mode
  const uploadDir = await getLocalUploadDir();
  const filePath = path.join(uploadDir, storageKey);

  try {
    return await fs.readFile(filePath);
  } catch {
    throw ApiError.notFound('File not found');
  }
}

// ────────────────────────────────────────────────────────────
// DELETE
// ────────────────────────────────────────────────────────────

/**
 * Delete a file from storage.
 */
export async function deleteFile(storageKey: string): Promise<void> {
  if (env.STORAGE_MODE === 's3') {
    const client = getS3Client();
    await client.send(
      new DeleteObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: storageKey,
      })
    );
    return;
  }

  // Local mode
  const uploadDir = await getLocalUploadDir();
  const filePath = path.join(uploadDir, storageKey);

  try {
    await fs.unlink(filePath);
  } catch {
    // File may already be deleted — that's fine
  }
}

/**
 * Check that the configured storage backend is actually reachable and writable.
 *
 * `HeadBucket` rather than a test upload: it costs nothing, needs no cleanup,
 * and fails for every reason a real upload would — bad credentials, wrong
 * endpoint, deleted bucket, network. The one thing it does not prove is write
 * permission, which R2 tokens can withhold separately; a scoped token that can
 * read but not write would pass this and fail on the first order. That is the
 * known gap, and it is caught by the first upload rather than by a probe that
 * leaves litter in the bucket on every health check.
 *
 * Throws with a usable message on failure; the caller turns it into a status.
 */
export async function probeStorage(): Promise<{ mode: string; detail: string }> {
  if (env.STORAGE_MODE === 's3') {
    const client = getS3Client();
    await client.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
    return { mode: 's3', detail: `bucket "${env.S3_BUCKET}" reachable` };
  }

  // Local mode is a red flag in itself outside development — assertProductionConfig
  // refuses to boot on it — but the probe still reports honestly rather than
  // claiming health it cannot verify.
  const uploadDir = await getLocalUploadDir();
  await fs.access(uploadDir);
  return {
    mode: 'local',
    detail: `writing to ${uploadDir} — ephemeral, files do not survive a redeploy`,
  };
}
