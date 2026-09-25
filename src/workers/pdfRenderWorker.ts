import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { pdfToPng } from 'pdf-to-png-converter';

/**
 * Dedicated Worker Thread for PDF to PNG rasterization.
 * Runs completely off the main Node.js event loop, preventing CPU starvation
 * and WebSocket heartbeat timeouts in Baileys.
 */
if (!isMainThread && parentPort) {
  (async () => {
    try {
      const { pdfBuffer, viewportScale = 1.5, pagesToProcess = [1] } = workerData || {};

      if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer) && !(pdfBuffer instanceof Uint8Array)) {
        parentPort?.postMessage({
          success: false,
          error: 'Invalid or empty PDF buffer passed to worker'
        });
        return;
      }

      const buffer = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);

      // Perform heavy canvas rasterization in this dedicated OS thread
      const pngPages = await pdfToPng(buffer, {
        pagesToProcess,
        viewportScale
      });

      if (pngPages && pngPages.length > 0 && pngPages[0].content) {
        parentPort?.postMessage({
          success: true,
          pngBuffer: Buffer.from(pngPages[0].content)
        });
      } else {
        parentPort?.postMessage({
          success: false,
          error: 'No image content rendered from PDF'
        });
      }
    } catch (err: any) {
      parentPort?.postMessage({
        success: false,
        error: err?.message || 'Unknown PDF worker render failure'
      });
    }
  })();
}
