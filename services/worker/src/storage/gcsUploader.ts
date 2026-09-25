import { Storage } from '@google-cloud/storage';

const storage = new Storage();
const bucketName = process.env.FIREBASE_STORAGE_BUCKET || 'run-sources-whatsapp-assistant-sa-me-central1';
const bucket = storage.bucket(bucketName);

/**
 * Uploads high-res flyer asset (rendered cover PNG or PDF) to GCS bucket.
 */
export async function uploadFlyerAsset(
  jobId: string,
  fileName: string,
  buffer: Buffer,
  mimeType: string = 'image/png'
): Promise<string | null> {
  if (!buffer || buffer.length === 0) return null;

  try {
    const cleanFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const destination = `flyers/${jobId}/${cleanFileName}`;
    const file = bucket.file(destination);

    await file.save(buffer, {
      metadata: {
        contentType: mimeType,
        metadata: {
          jobId,
          originalName: fileName,
          uploadedAt: new Date().toISOString()
        }
      },
      resumable: false
    });

    console.log(`[INFO] [STORAGE] Archived flyer to gs://${bucketName}/${destination} (${(buffer.length / 1024).toFixed(1)} KB)`);
    return destination;
  } catch (error: any) {
    console.warn(`[WARN] [STORAGE] Failed to archive asset "${fileName}":`, error.message);
    return null;
  }
}
