import { downloadContentFromMessage } from '@whiskeysockets/baileys';

export interface DownloadableDocumentPayload {
  fileName: string;
  directPath?: string;
  url?: string;
  mediaKey?: string;
  fileEncSha256?: string;
  fileSha256?: string;
  thumbnailBase64?: string;
}

/**
 * Downloads and decrypts WhatsApp document media statelessly using raw mediaKey.
 * Completely decoupled from active WebSocket connections.
 */
export async function downloadWhatsAppMedia(docPayload: DownloadableDocumentPayload): Promise<Buffer | null> {
  // If no media keys, fall back immediately to embedded thumbnail
  if (!docPayload.mediaKey || !docPayload.directPath) {
    if (docPayload.thumbnailBase64) {
      return Buffer.from(docPayload.thumbnailBase64, 'base64');
    }
    return null;
  }

  try {
    const stream = await downloadContentFromMessage(
      {
        url: docPayload.url,
        directPath: docPayload.directPath,
        mediaKey: Buffer.from(docPayload.mediaKey, 'base64'),
        fileEncSha256: docPayload.fileEncSha256 ? Buffer.from(docPayload.fileEncSha256, 'base64') : undefined,
        fileSha256: docPayload.fileSha256 ? Buffer.from(docPayload.fileSha256, 'base64') : undefined
      } as any,
      'document'
    );

    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (err: any) {
    console.warn(`[WA DOWNLOADER] Direct CDN download failed for "${docPayload.fileName}":`, err?.message);
    if (docPayload.thumbnailBase64) {
      console.log(`[WA DOWNLOADER] Falling back to embedded thumbnail for "${docPayload.fileName}"`);
      return Buffer.from(docPayload.thumbnailBase64, 'base64');
    }
    return null;
  }
}
