import 'dotenv/config';
import express, { Request, Response } from 'express';
import { downloadWhatsAppMedia } from './downloader/waMediaDownloader';
import { 
  renderPdfPage1ToPng, 
  extractPdfMetadata, 
  parseAdsproMultimodalJob 
} from './parser/adsproParser';
import { appendAdsproJobToSheet } from './sheets/adsproSheets';
import { uploadFlyerAsset } from './storage/gcsUploader';

const app = express();
app.use(express.json({ limit: '50mb' }));

app.get(['/', '/health', '/healthz'], (req: Request, res: Response) => {
  res.status(200).json({
    status: 'healthy',
    service: 'adspro-cloud-run-worker',
    region: process.env.GCP_REGION || 'me-central1',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.post('/process-job', async (req: Request, res: Response) => {
  const startTime = Date.now();
  const payload = req.body;

  if (!payload || !payload.jobId || !Array.isArray(payload.documents)) {
    res.status(400).json({
      success: false,
      error: 'Invalid payload: jobId and documents array are required.'
    });
    return;
  }

  const { jobId, specText, documents, createdAt } = payload;
  console.log(`\n[INFO] [WORKER] Processing Job [${jobId}] (${documents.length} docs)`);

  try {
    const primaryDoc = documents[0];
    let page1Image: Buffer | null = null;
    let pageCount = primaryDoc?.pageCount || 1;
    let pdfTitle: string | undefined = primaryDoc?.pdfTitle;

    // 1. Stateless Download & Page 1 Render
    if (primaryDoc) {
      const downloadedBuffer = await downloadWhatsAppMedia({
        fileName: primaryDoc.fileName,
        directPath: primaryDoc.directPath,
        url: primaryDoc.url,
        mediaKey: primaryDoc.mediaKey,
        fileEncSha256: primaryDoc.fileEncSha256,
        fileSha256: primaryDoc.fileSha256,
        thumbnailBase64: primaryDoc.thumbnailBase64
      });

      if (downloadedBuffer && downloadedBuffer.length > 0) {
        // Only attempt PDF metadata extraction and rasterization if buffer is actually a PDF (starts with '%PDF')
        const isPdf = downloadedBuffer.subarray(0, 4).toString() === '%PDF';
        if (isPdf) {
          const meta = await extractPdfMetadata(downloadedBuffer);
          pdfTitle = meta.title || pdfTitle;
          if (meta.pageCount > 1) {
            pageCount = meta.pageCount;
          }
          page1Image = await renderPdfPage1ToPng(downloadedBuffer);
        } else {
          // It's already an image (e.g. pre-rendered PNG cover or embedded JPEG thumbnail)
          page1Image = downloadedBuffer;
        }
      } else if (primaryDoc.thumbnailBase64) {
        page1Image = Buffer.from(primaryDoc.thumbnailBase64, 'base64');
      }
    }

    // 2. Multimodal AI Extraction (Visual Cover + WhatsApp Specs)
    const fileNames = documents.map((d: any) => d.fileName);
    const parsedSpec = await parseAdsproMultimodalJob({
      imageBuffer: page1Image || undefined,
      specText: specText || '',
      fileNames,
      declaredPageCount: pageCount,
      pdfTitle
    });

    console.log(`[INFO] [WORKER] Identified: "${parsedSpec.shopName}" | Work: "${parsedSpec.workDetails}" | Qty: ${parsedSpec.quantity} | Pages: ${parsedSpec.pageCount}`);

    // 3. Archive cover image to Cloud Storage
    if (page1Image) {
      uploadFlyerAsset(jobId, `${fileNames[0] || 'flyer'}_cover.png`, page1Image, 'image/png').catch(err =>
        console.warn('[STORAGE] Async archive warning:', err?.message)
      );
    }

    // 4. Check NOT_FOUND Escape Hatch
    if (parsedSpec.shopName === 'NOT_FOUND' || parsedSpec.shopName.includes('NOT_FOUND')) {
      console.warn(`[WARN] [WORKER] Store brand unidentifiable for Job [${jobId}]. Skipping sheet entry.`);
      res.status(200).json({
        success: true,
        jobId,
        skippedForManualReview: true,
        jobCategory: parsedSpec.jobCategory,
        shopName: 'NOT_FOUND',
        workDetails: parsedSpec.workDetails,
        pageCount: parsedSpec.pageCount,
        quantity: parsedSpec.quantity
      });
      return;
    }

    // 5. Append to Google Sheets
    const sheetResult = await appendAdsproJobToSheet({
      shopName: parsedSpec.shopName,
      workDetails: parsedSpec.workDetails,
      pageCount: parsedSpec.pageCount,
      quantity: parsedSpec.quantity,
      timestamp: createdAt ? new Date(createdAt) : new Date()
    });

    const elapsed = Date.now() - startTime;
    console.log(`[INFO] [WORKER] Job [${jobId}] saved to "${sheetResult.sheetTitle}" at Row ${sheetResult.rowIndex} (${elapsed}ms)`);

    res.status(200).json({
      success: true,
      jobId,
      jobCategory: parsedSpec.jobCategory,
      shopName: parsedSpec.shopName,
      workDetails: parsedSpec.workDetails,
      pageCount: parsedSpec.pageCount,
      quantity: parsedSpec.quantity,
      sheetTitle: sheetResult.sheetTitle,
      rowIndex: sheetResult.rowIndex,
      siNo: sheetResult.siNo
    });
  } catch (error: any) {
    console.error(`[ERROR] [WORKER] Fatal error processing Job [${jobId}]:`, error);
    res.status(500).json({
      success: false,
      jobId,
      error: error?.message || 'Internal Cloud Run Worker Error'
    });
  }
});

const PORT = parseInt(process.env.PORT || '8080', 10);
app.listen(PORT, () => {
  console.log(`[INFO] [WORKER] Operational on port ${PORT} in ${process.env.GCP_REGION || 'me-central1'}`);
});
