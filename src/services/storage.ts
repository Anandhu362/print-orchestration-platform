import { flyerBucket } from '../database/firebase';

/**
 * Uploads a flyer file (PDF or rendered PNG cover) to Cloud Storage.
 * Stores under: flyers/<jobId>/<fileName>
 */
export async function uploadFlyerAsset(
  jobId: string,
  fileName: string,
  buffer: Buffer,
  mimeType: string = 'application/pdf'
): Promise<string | null> {
  if (!buffer || buffer.length === 0) return null;

  try {
    const cleanFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const destination = `flyers/${jobId}/${cleanFileName}`;
    const file = flyerBucket.file(destination);

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

    console.log(`[INFO] [STORAGE] Archived flyer to gs://${flyerBucket.name}/${destination} (${(buffer.length / 1024).toFixed(1)} KB)`);
    return destination;
  } catch (error: any) {
    console.warn(`[WARN] [STORAGE] Failed to archive flyer asset "${fileName}":`, error.message);
    return null;
  }
}
