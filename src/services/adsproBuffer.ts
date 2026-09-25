import { WASocket } from '@whiskeysockets/baileys';
import { parseAdsproMultimodalJob, isPageBurstFilename } from './adsproParser';
import { appendAdsproJobToSheet } from './adsproSheets';
import { uploadFlyerAsset } from './storage';
import { firestore } from '../database/firebase';
import { cloudRunClient } from './cloudRunClient';
import { JobDispatchPayload } from '../shared/types/jobPayload';

export interface StagedDocument {
  messageId: string;
  fileName: string;
  fileLength?: number;
  pageCount?: number;
  thumbnail?: Buffer;
  page1Image?: Buffer;
  caption?: string;
  pdfText?: string;
  pdfTitle?: string;
  isMediaReady: boolean;
  timestamp: number;
}

export interface StagedJob {
  jobId: string;
  groupId: string; // Group JID or direct chat JID
  senderId: string;
  documents: StagedDocument[];
  specText: string;
  hasCaption: boolean;
  isPageBurst: boolean;
  isDirectChat: boolean;
  createdAt: number;
  lastActivityAt: number;
  targetFinalizeTime: number;
  timer: NodeJS.Timeout;
}

// Timing Configuration:
// 1. If flyer has NO caption yet: wait 2 minutes fallback (120s) for typing / deletes.
// 2. If flyer HAS a caption (or receives one within 60s): close at the 1-minute mark (60s).
// 3. Minimum settle safety buffer: 15s (if caption arrives near or after 60s).
export const FALLBACK_WINDOW_MS = 120 * 1000;
export const EXPEDITED_WINDOW_MS = 60 * 1000;
export const MIN_SETTLE_BUFFER_MS = 15 * 1000;

/**
 * Checks if a user's text message explicitly mentions the file name or distinctive brand
 */
function matchesFileName(fileName: string, text: string): boolean {
  if (!fileName || !text) return false;
  const cleanDocName = fileName.replace(/\.[^/.]+$/, '').toLowerCase();
  const words = cleanDocName.split(/[\s_\-]+/).filter(w => w.length >= 3 && !/^(promo|flayer|flyer|pdf|file|doc|final|page)$/i.test(w));
  const textLower = text.toLowerCase();
  return words.some(w => textLower.includes(w));
}

class AdsproJobBuffer {
  private activeJobs = new Map<string, StagedJob>();
  private orphanReplyCache = new Map<string, { text: string; senderId: string; timestamp: number }>();
  private processingQueue: StagedJob[] = [];
  private isProcessingQueue = false;
  private sock: WASocket | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.startTtlCleanupLoop();
  }

  /**
   * Initializes periodic TTL eviction loop running every 10 minutes.
   */
  private startTtlCleanupLoop(): void {
    this.cleanupTimer = setInterval(() => {
      this.evictStaleEntries();
    }, 10 * 60 * 1000);
    this.cleanupTimer.unref?.();
  }

  /**
   * Garbage collects expired orphan replies (> 15m) and stuck abandoned jobs (> 2h).
   * Supports customizable TTL for unit/stress testing.
   */
  public evictStaleEntries(orphanTtlMs: number = 15 * 60 * 1000, jobTtlMs: number = 2 * 60 * 60 * 1000): { evictedOrphans: number; evictedJobs: number } {
    const now = Date.now();
    let evictedOrphans = 0;
    for (const [key, entry] of this.orphanReplyCache.entries()) {
      if (now - entry.timestamp > orphanTtlMs) {
        this.orphanReplyCache.delete(key);
        evictedOrphans++;
      }
    }
    if (evictedOrphans > 0) {
      console.log(`[INFO] [BUFFER GC] Evicted ${evictedOrphans} expired orphan reply cache entries.`);
    }

    let evictedJobs = 0;
    for (const [jobId, job] of this.activeJobs.entries()) {
      if (now - job.createdAt > jobTtlMs) {
        clearTimeout(job.timer);
        this.activeJobs.delete(jobId);
        evictedJobs++;
        console.warn(`[WARN] [BUFFER GC] Pruned stale stuck job [${jobId}] (${job.documents.map(d => d.fileName).join(', ')})`);
      }
    }
    return { evictedOrphans, evictedJobs };
  }

  /**
   * Diagnostic helper: returns current count of active orphan replies.
   */
  public getOrphanReplyCount(): number {
    return this.orphanReplyCache.size;
  }

  /**
   * Diagnostic helper: returns current count of staged active jobs.
   */
  public getActiveJobCount(): number {
    return this.activeJobs.size;
  }

  /**
   * Testing helper: injects an orphan reply directly into cache.
   */
  public setOrphanReplyForTest(stanzaId: string, text: string, senderId: string, timestamp: number): void {
    this.orphanReplyCache.set(stanzaId, { text, senderId, timestamp });
  }

  /**
   * Sets the active WhatsApp socket reference for direct-chat receipts.
   */
  public setSocket(sock: WASocket): void {
    this.sock = sock;
  }

  /**
   * Immediately registers a document upload into the staging buffer (< 1ms).
   * Decoupled from heavy media downloading and PDF rendering.
   * Returns whether this document is a continuation page in an existing burst job.
   */
  public async handleIncomingDocument(
    groupId: string,
    senderId: string,
    messageId: string,
    docMeta: {
      fileName: string;
      fileLength?: number;
      pageCount?: number;
      thumbnail?: Buffer;
      page1Image?: Buffer;
      caption?: string;
      pdfText?: string;
      pdfTitle?: string;
    },
    isDirectChat: boolean = false
  ): Promise<{ isBurstContinuation: boolean; jobId: string }> {
    const now = Date.now();
    const isBurst = isPageBurstFilename(docMeta.fileName) || (docMeta.pageCount === 1 && isPageBurstFilename(docMeta.fileName));
    const pages = docMeta.pageCount || 1;
    const chatType = isDirectChat ? 'Direct Chat' : 'Group';

    // Check if an orphan reply arrived before this document finished registration
    let initialSpecText = docMeta.caption || '';
    let hasDocCaption = Boolean(docMeta.caption && docMeta.caption.trim().length > 0);

    if (this.orphanReplyCache.has(messageId)) {
      const orphan = this.orphanReplyCache.get(messageId)!;
      this.orphanReplyCache.delete(messageId);
      initialSpecText = initialSpecText ? `${initialSpecText}\n${orphan.text}` : orphan.text;
      hasDocCaption = true;
      console.log(`[INFO] [BUFFER] Bound pending reply "${orphan.text}" to newly registered doc "${docMeta.fileName}" (MsgId: ${messageId})`);
    }

    const isMediaReady = Boolean(docMeta.page1Image || !docMeta.fileName.toLowerCase().endsWith('.pdf'));

    // 1. Check if there is an active job for THIS sender that this document should append to (Burst Page):
    const existingBurstJob = Array.from(this.activeJobs.values()).find(
      j => j.groupId === groupId && j.senderId === senderId && (j.isPageBurst || isBurst)
    );

    if (existingBurstJob && (existingBurstJob.isPageBurst || isBurst)) {
      existingBurstJob.isPageBurst = true;
      console.log(`[INFO] [BUFFER] Appended burst page "${docMeta.fileName}" to Job [${existingBurstJob.jobId}] (${senderId}). Total pages: ${existingBurstJob.documents.length + 1}`);
      existingBurstJob.documents.push({
        messageId,
        fileName: docMeta.fileName,
        fileLength: docMeta.fileLength,
        pageCount: docMeta.pageCount || 1,
        thumbnail: docMeta.thumbnail,
        page1Image: docMeta.page1Image,
        caption: docMeta.caption,
        pdfText: docMeta.pdfText,
        pdfTitle: docMeta.pdfTitle,
        isMediaReady,
        timestamp: now
      });
      existingBurstJob.lastActivityAt = now;
      if (hasDocCaption) {
        existingBurstJob.specText = existingBurstJob.specText ? `${existingBurstJob.specText}\n${initialSpecText}` : initialSpecText;
        existingBurstJob.hasCaption = true;
      }
      this.recalculateJobTimer(existingBurstJob);
      return { isBurstContinuation: true, jobId: existingBurstJob.jobId };
    }

    // 2. Otherwise, spawn an independent job pipeline immediately
    const newJobId = `job_${messageId}`;
    const initialDelayMs = hasDocCaption ? EXPEDITED_WINDOW_MS : FALLBACK_WINDOW_MS;
    const targetFinalizeTime = now + initialDelayMs;

    const timerType = hasDocCaption ? '1-Minute Expedited Window (Caption Included)' : '2-Minute Fallback Window (Waiting for Caption)';
    console.log(`[INFO] [BUFFER] Document received: "${docMeta.fileName}" (MsgId: ${messageId}) | Sender: ${senderId} (${chatType}) | ${timerType}`);

    const newJob: StagedJob = {
      jobId: newJobId,
      groupId,
      senderId,
      documents: [{
        messageId,
        fileName: docMeta.fileName,
        fileLength: docMeta.fileLength,
        pageCount: docMeta.pageCount || 1,
        thumbnail: docMeta.thumbnail,
        page1Image: docMeta.page1Image,
        caption: docMeta.caption,
        pdfText: docMeta.pdfText,
        pdfTitle: docMeta.pdfTitle,
        isMediaReady,
        timestamp: now
      }],
      specText: initialSpecText,
      hasCaption: hasDocCaption,
      isPageBurst: isBurst,
      isDirectChat,
      createdAt: now,
      lastActivityAt: now,
      targetFinalizeTime,
      timer: setTimeout(() => this.enqueueJobForExecution(newJobId), initialDelayMs)
    };

    this.activeJobs.set(newJobId, newJob);
    return { isBurstContinuation: false, jobId: newJobId };
  }

  /**
   * Updates a document when its background media download & Page 1 render finishes.
   */
  public updateDocumentMedia(
    messageId: string,
    media: {
      page1Image?: Buffer;
      pageCount?: number;
      pdfTitle?: string;
    }
  ): void {
    for (const job of this.activeJobs.values()) {
      const doc = job.documents.find(d => d.messageId === messageId);
      if (doc) {
        if (media.page1Image) doc.page1Image = media.page1Image;
        if (media.pageCount) doc.pageCount = media.pageCount;
        if (media.pdfTitle) doc.pdfTitle = media.pdfTitle;
        doc.isMediaReady = true;
        console.log(`[INFO] [BUFFER] High-res render attached to Job [${job.jobId}] ("${doc.fileName}")`);
        return;
      }
    }
  }

  /**
   * Registers an incoming text specification message and binds it with STRICT multi-sender isolation.
   * Priority 1: Quoted reply (100% deterministic via WhatsApp stanzaId).
   *             NEVER falls back to another job if a quoted reply was provided.
   * Priority 2: File Name mention matching (only if unquoted).
   * Priority 3: Sender Affinity for unquoted text (only matches pending jobs from THIS sender with NO specs).
   */
  public async handleIncomingText(
    groupId: string,
    senderId: string,
    text: string,
    quotedMessageId?: string,
    _isDirectChat: boolean = false
  ): Promise<void> {
    if (!text || !text.trim()) return;
    const cleanText = text.trim();

    // ------------------------------------------------------------------------
    // CASE A: USER REPLIED VIA QUOTE (Explicit stanzaId)
    // ------------------------------------------------------------------------
    if (quotedMessageId) {
      const targetJob = Array.from(this.activeJobs.values()).find(job =>
        job.documents.some(doc => doc.messageId === quotedMessageId)
      );

      if (targetJob) {
        console.log(`[INFO] [BUFFER] Spec text "${cleanText}" bound strictly to "${targetJob.documents[0]?.fileName}" (Job: ${targetJob.jobId}) via quoted messageId: ${quotedMessageId}`);
        targetJob.specText = targetJob.specText ? `${targetJob.specText}\n${cleanText}` : cleanText;
        targetJob.hasCaption = true;
        targetJob.lastActivityAt = Date.now();
        this.recalculateJobTimer(targetJob);
        return;
      }

      // If document has not registered yet (e.g. slight network out-of-order delivery), cache it as orphan!
      // CRITICAL: DO NOT FALL BACK TO SENDER AFFINITY!
      console.log(`[INFO] [BUFFER] Quoted stanzaId "${quotedMessageId}" not yet in active jobs. Caching "${cleanText}" for doc arrival.`);
      this.orphanReplyCache.set(quotedMessageId, {
        text: cleanText,
        senderId,
        timestamp: Date.now()
      });
      return;
    }

    // ------------------------------------------------------------------------
    // CASE B: PURE UNQUOTED TEXT MESSAGE
    // ------------------------------------------------------------------------
    let targetJob: StagedJob | undefined;

    // Strategy 2: File Name Mention in text (e.g., user types "Western 3000 22x33" or "Daily 5000 a3")
    targetJob = Array.from(this.activeJobs.values()).find(job =>
      job.groupId === groupId && job.documents.some(doc => matchesFileName(doc.fileName, cleanText))
    );

    if (targetJob) {
      console.log(`[INFO] [BUFFER] "${cleanText}" bound to "${targetJob.documents[0]?.fileName}" (Job: ${targetJob.jobId}) via filename mention`);
    }

    // Strategy 3: Sender Affinity (only match THIS sender's pending job that DOES NOT already have specs)
    if (!targetJob) {
      const senderJobs = Array.from(this.activeJobs.values())
        .filter(j => j.groupId === groupId && j.senderId === senderId && !j.hasCaption)
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt);

      if (senderJobs.length > 0) {
        targetJob = senderJobs[0];
        console.log(`[INFO] [BUFFER] "${cleanText}" bound to "${targetJob.documents[0]?.fileName}" (Job: ${targetJob.jobId}) via sender affinity (${senderId})`);
      }
    }

    // If successfully bound to an unquoted job:
    if (targetJob) {
      targetJob.specText = targetJob.specText ? `${targetJob.specText}\n${cleanText}` : cleanText;
      targetJob.hasCaption = true;
      targetJob.lastActivityAt = Date.now();
      this.recalculateJobTimer(targetJob);
    } else {
      console.log(`[INFO] [BUFFER] Received unquoted text "${cleanText}" from ${senderId}, but no matching active flyer without specs was found.`);
    }
  }

  /**
   * Recalculates and expedites the debounce timer for a staged job.
   * If caption is present, closes at the 1-minute mark from creation (or +15s settle buffer).
   */
  private recalculateJobTimer(job: StagedJob): void {
    clearTimeout(job.timer);
    const now = Date.now();

    if (job.hasCaption) {
      // 1-Minute Rule: Close at createdAt + 60s, or now + 15s minimum settle buffer
      const expeditedTarget = job.createdAt + EXPEDITED_WINDOW_MS;
      const minSettleTarget = now + MIN_SETTLE_BUFFER_MS;
      const targetTime = Math.max(expeditedTarget, minSettleTarget);
      const remainingMs = Math.max(targetTime - now, 1000);

      job.targetFinalizeTime = targetTime;
      job.timer = setTimeout(() => this.enqueueJobForExecution(job.jobId), remainingMs);
      console.log(`[INFO] [BUFFER] Job [${job.jobId}] ("${job.documents[0]?.fileName}") will finalize in ${Math.round(remainingMs / 1000)}s (1-Minute Rule)`);
    } else {
      // 2-Minute Fallback Rule: Waiting for caption
      const fallbackTarget = job.createdAt + FALLBACK_WINDOW_MS;
      const remainingMs = Math.max(fallbackTarget - now, 1000);

      job.targetFinalizeTime = fallbackTarget;
      job.timer = setTimeout(() => this.enqueueJobForExecution(job.jobId), remainingMs);
    }
  }

  /**
   * Intercepts WhatsApp "Delete for Everyone" messages (protocolMessage.type === 0).
   * Purges recalled files before they can ever be logged.
   */
  public async handleMessageRevoke(revokedMessageId: string): Promise<void> {
    for (const [jobId, job] of this.activeJobs.entries()) {
      const docIndex = job.documents.findIndex(d => d.messageId === revokedMessageId);
      if (docIndex !== -1) {
        const removedDoc = job.documents.splice(docIndex, 1)[0];
        console.log(`[INFO] [BUFFER] Recalled "${removedDoc.fileName}" (MsgId: ${revokedMessageId}). Purged from Job [${jobId}].`);

        if (job.documents.length === 0) {
          clearTimeout(job.timer);
          this.activeJobs.delete(jobId);
          console.log(`[INFO] [BUFFER] Job [${jobId}] has no remaining documents. Safely dismissed.`);
        }
        return;
      }
    }
  }

  /**
   * Enqueues a job when its debounce window finishes.
   * Guarantees orderly sequential processing via FIFO queue.
   */
  public enqueueJobForExecution(jobId: string): void {
    const job = this.activeJobs.get(jobId);
    if (!job) return;

    this.activeJobs.delete(jobId);
    console.log(`\n[INFO] [BUFFER] Safety window elapsed for Job [${jobId}] ("${job.documents[0]?.fileName}"). Queued for extraction.`);
    this.processingQueue.push(job);
    this.processQueue();
  }

  /**
   * Alias for backward compatibility.
   */
  public async finalizeAndCommitJob(jobId: string): Promise<void> {
    this.enqueueJobForExecution(jobId);
  }

  /**
   * Sequential queue worker: processes jobs one-by-one to prevent Google Sheets write collisions.
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue) return;
    if (this.processingQueue.length === 0) return;

    this.isProcessingQueue = true;

    while (this.processingQueue.length > 0) {
      const job = this.processingQueue.shift()!;
      try {
        console.log(`[INFO] [QUEUE] Processing Job [${job.jobId}] ("${job.documents[0]?.fileName}") | Queue Remaining: ${this.processingQueue.length}`);
        await this.executeJobCommit(job);
      } catch (err: any) {
        console.error(`[ERROR] [QUEUE] Unrecoverable error processing Job [${job.jobId}]:`, err.message);

        // DEAD-LETTER QUEUE (DLQ): Persist failed order to Firestore for manual recovery
        try {
          await firestore.collection('failed_orders').doc(job.jobId).set({
            jobId: job.jobId,
            groupId: job.groupId,
            senderId: job.senderId,
            fileNames: job.documents.map(d => d.fileName),
            specText: job.specText,
            isDirectChat: job.isDirectChat,
            error: err?.message || String(err),
            stack: err?.stack || '',
            failedAt: new Date().toISOString(),
            status: 'UNPROCESSED'
          });
          console.log(`[INFO] [DLQ] Order Job [${job.jobId}] safely stored in Firestore collection "failed_orders".`);
        } catch (dlqErr: any) {
          console.error(`[ERROR] [DLQ] Could not persist failed job [${job.jobId}] to Firestore:`, dlqErr?.message);
        }

        // Notify user if direct chat
        if (job.isDirectChat && this.sock) {
          try {
            await this.sock.sendMessage(job.groupId, {
              text: `*ORDER LOGGING NOTICE*\n\n` +
                    `An unexpected issue occurred while saving your order for *${job.documents.map(d => d.fileName).join(', ')}*.\n` +
                    `The details have been safely queued in our system for manual review and entry by the team.`
            });
          } catch (notifyErr: any) {
            console.error('Failed to deliver error notification to direct user:', notifyErr?.message);
          }
        }
      }
    }

    this.isProcessingQueue = false;
  }

  /**
   * Performs the Multimodal AI extraction, Google Sheets commit, and WhatsApp receipt delivery.
   */
  private async executeJobCommit(job: StagedJob): Promise<void> {
    const fileNames = job.documents.map(d => d.fileName);

    // 1. Ensure background media download & render is complete before triggering Gemini or Cloud Run
    const pendingMedia = job.documents.filter(d => !d.isMediaReady);
    if (pendingMedia.length > 0) {
      console.log(`[INFO] [BUFFER] Waiting for ${pendingMedia.length} background render(s) to complete on Job [${job.jobId}]...`);
      const startWait = Date.now();
      while (job.documents.some(d => !d.isMediaReady) && (Date.now() - startWait) < 15000) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // 0. OPTIONAL CLOUD RUN DISPATCH (Offloads heavy compute to serverless container in me-central1)
    if (cloudRunClient.isCloudRunConfigured()) {
      try {
        const dispatchPayload: JobDispatchPayload = {
          jobId: job.jobId,
          groupId: job.groupId,
          senderId: job.senderId,
          specText: job.specText,
          isDirectChat: job.isDirectChat,
          createdAt: job.createdAt,
          documents: job.documents.map(d => ({
            messageId: d.messageId,
            fileName: d.fileName,
            fileLength: d.fileLength,
            pageCount: d.pageCount,
            thumbnailBase64: d.page1Image ? d.page1Image.toString('base64') : (d.thumbnail ? d.thumbnail.toString('base64') : undefined),
            caption: d.caption,
            pdfTitle: d.pdfTitle
          }))
        };

        const crResult = await cloudRunClient.dispatchJob(dispatchPayload);
        if (crResult.success) {
          if (crResult.skippedForManualReview) {
            console.warn(`[WARN] [OCR] Store brand unidentifiable by Cloud Run for Job [${job.jobId}].`);
            if (job.isDirectChat && this.sock) {
              await this.sock.sendMessage(job.groupId, {
                text: `*ORDER SKIPPED FOR MANUAL REVIEW*\n\n` +
                      `The store brand name could not be identified by the Cloud Run worker.\n` +
                      `File: ${fileNames.join(', ')}\n` +
                      `Please cross-check the flyer and log it manually.`
              });
            }
            return;
          }

          console.log(`[INFO] [SHEETS] Saved Job #${crResult.siNo} for "${crResult.shopName}" to "${crResult.sheetTitle}" at Row ${crResult.rowIndex} (via Cloud Run)`);

          if (job.isDirectChat && this.sock) {
            const receiptText = 
              `*PRINT ORDER CONFIRMATION*\n\n` +
              `Shop / Client: ${crResult.shopName}\n` +
              `Work Details: ${crResult.workDetails}\n` +
              `NO.PAGE: ${crResult.pageCount}\n` +
              `Quantity: ${crResult.quantity?.toLocaleString()}\n` +
              `Weekly Tab: ${crResult.sheetTitle} (Row ${crResult.rowIndex}, Sl.No ${crResult.siNo})\n` +
              `File: ${fileNames.join(', ')}`;
            await this.sock.sendMessage(job.groupId, { text: receiptText });
          } else {
            console.log(`[INFO] [DISPATCH] Order committed by Cloud Run in 100% silent mode\n`);
          }
          return;
        }
        console.warn(`[WARN] [CLOUD RUN] Cloud Run worker dispatch unsuccessful (${crResult.error}). Engaging local in-process fallback...`);
      } catch (crErr: any) {
        console.warn(`[WARN] [CLOUD RUN] Error invoking Cloud Run. Falling back to local engine:`, crErr?.message);
      }
    }

    const firstImage = job.documents.find(d => !!d.page1Image)?.page1Image || job.documents.find(d => !!d.thumbnail)?.thumbnail;
    const combinedPdfTitle = job.documents.find(d => !!d.pdfTitle)?.pdfTitle;

    // Calculate total page count
    let totalPages = 1;
    if (job.isPageBurst && job.documents.length > 1) {
      totalPages = job.documents.reduce((acc, d) => acc + (d.pageCount || 1), 0);
    } else if (job.documents[0]?.pageCount) {
      totalPages = job.documents[0].pageCount;
    }

    // Run Unified Multimodal Engine (Visual Image + WhatsApp Order Specs in ONE pass)
    const parsedSpec = await parseAdsproMultimodalJob({
      imageBuffer: firstImage,
      specText: job.specText,
      fileNames,
      declaredPageCount: totalPages,
      pdfTitle: combinedPdfTitle
    });

    console.log(`[INFO] [EXTRACTED] Category: "${parsedSpec.jobCategory || 'FLYER'}" | Shop: "${parsedSpec.shopName}" | Work: "${parsedSpec.workDetails}" | Pages: ${parsedSpec.pageCount} | Qty: ${parsedSpec.quantity}`);

    // Asynchronously archive the visual cover image to Cloud Storage bucket
    if (firstImage) {
      uploadFlyerAsset(job.jobId, `${fileNames[0] || 'flyer'}_cover.png`, firstImage, 'image/png').catch(err =>
        console.warn('[WARN] [STORAGE] Cover archive notice:', err)
      );
    }

    // 2. CHECK NOT_FOUND ESCAPE HATCH: If brand or branch location is unreadable/missing, skip Google Sheets commit!
    if (parsedSpec.shopName === 'NOT_FOUND' || parsedSpec.shopName.includes('NOT_FOUND')) {
      console.warn(`[WARN] [NOT_FOUND] Store brand or branch location could not be reliably identified for Job [${job.jobId}] ("${fileNames.join(', ')}").`);
      console.log(`[INFO] [MANUAL REVIEW] Skipping automatic Google Sheets entry to prevent unverified data. Manual review required.`);

      // If direct chat, notify the user that manual entry/review is required
      if (job.isDirectChat && this.sock) {
        try {
          const skipNotice =
            `*ORDER SKIPPED FOR MANUAL REVIEW*\n\n` +
            `The store brand name or branch location could not be clearly identified from the flyer.\n` +
            `To prevent incorrect entries in the spreadsheet, this job was not saved to Google Sheets.\n\n` +
            `File: ${fileNames.join(', ')}\n` +
            `Detected Pages: ${parsedSpec.pageCount}\n` +
            `Work Details: ${parsedSpec.workDetails}\n` +
            `Quantity: ${parsedSpec.quantity.toLocaleString()}\n\n` +
            `Please cross-check the flyer and log it to the spreadsheet manually.`;

          await this.sock.sendMessage(job.groupId, { text: skipNotice });
          console.log(`[INFO] [NOTICE] Sent manual review notice to ${job.senderId}\n`);
        } catch (err) {
          console.error(`[ERROR] [NOTICE] Failed to deliver WhatsApp manual review notice:`, err);
        }
      } else {
        console.log(`[INFO] [DISPATCH] Skipped unverified order in 100% silent mode (0 messages sent to group)\n`);
      }

      return; // DO NOT COMMIT TO GOOGLE SHEETS!
    }

    // Commit to Google Sheet
    const result = await appendAdsproJobToSheet({
      shopName: parsedSpec.shopName,
      workDetails: parsedSpec.workDetails,
      pageCount: parsedSpec.pageCount,
      quantity: parsedSpec.quantity,
      timestamp: new Date(job.createdAt)
    });

    console.log(`[INFO] [SHEETS] Saved Job #${result.siNo} for "${parsedSpec.shopName}" to "${result.sheetTitle}" at Row ${result.rowIndex}`);

    // Only in Direct Chat: Deliver the single, final confirmation receipt
    if (job.isDirectChat && this.sock) {
      try {
        const categoryLabel = parsedSpec.jobCategory === 'VISITING_CARD' ? 'Visiting Card' :
                              parsedSpec.jobCategory === 'COUPON' ? 'Coupon' :
                              parsedSpec.jobCategory === 'STICKER' ? 'Sticker' :
                              parsedSpec.jobCategory === 'DANGLER' ? 'Dangler' :
                              parsedSpec.jobCategory === 'PUSH_PULL' ? 'Push & Pull Sticker' :
                              parsedSpec.jobCategory === 'VINYL' ? 'Vinyl Print' :
                              parsedSpec.jobCategory === 'BOARD' ? 'Rigid Board' :
                              parsedSpec.jobCategory === 'ROLLUP' ? 'Rollup Banner' : 'Flyer';

        const receiptText = 
          `*PRINT ORDER CONFIRMATION*\n\n` +
          `Category: ${categoryLabel}\n` +
          `Shop / Client: ${parsedSpec.shopName}\n` +
          `Work Details: ${parsedSpec.workDetails}\n` +
          `NO.PAGE: ${parsedSpec.pageCount}\n` +
          `Quantity: ${parsedSpec.quantity.toLocaleString()}\n` +
          `Weekly Tab: ${result.sheetTitle} (Row ${result.rowIndex}, Sl.No ${result.siNo})\n` +
          `File: ${fileNames.join(', ')}`;

        await this.sock.sendMessage(job.groupId, { text: receiptText });
        console.log(`[INFO] [RECEIPT] Delivered final confirmation receipt to ${job.senderId}\n`);
      } catch (err) {
        console.error(`[ERROR] [RECEIPT] Failed to deliver WhatsApp receipt:`, err);
      }
    } else {
      console.log(`[INFO] [DISPATCH] Order committed in 100% silent mode (0 messages sent to group)\n`);
    }
  }
}

// Export singleton instance
export const adsproBuffer = new AdsproJobBuffer();
