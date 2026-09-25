import { WASocket, proto, downloadMediaMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import { env } from '../config/environment';
import { 
  isAuthorizedUser, 
  isPrimaryAdmin, 
  registerAuthorizedGroup, 
  getAuthorizedGroups, 
  authorizeUserInFirestore, 
  normalizeUserId,
  DESIGNATED_ADMIN_NUMBER,
  getGroupTitle
} from '../services/auth';
import { adsproBuffer } from './adsproBuffer';
import { extractPdfMetadata, renderPdfPage1ToPng } from './adsproParser';
import { cleanExpiredFlyers } from '../cron/bucketCleaner';


// ============================================================================
// RATE LIMITING & COOLDOWN ENGINES (In-Memory Sliding Window for Direct Chats)
// ============================================================================
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute window
const MAX_REQUESTS_PER_WINDOW = 15; // Max messages allowed per minute per user
export const ADMIN_ALERT_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours

export const requestTracker = new Map<string, number[]>();
export const warningTracker = new Map<string, number>();
export const adminNotificationTracker = new Map<string, number>();
const discoveredGroups = new Set<string>();

/**
 * Dispatches an admin notification to all registered admin endpoints (+91 8921156958 & PRIMARY_ADMIN_NUMBER).
 */
async function notifyAdmins(sock: WASocket, text: string): Promise<void> {
  const adminEndpoints = new Set<string>();
  if (DESIGNATED_ADMIN_NUMBER) {
    adminEndpoints.add(`${normalizeUserId(DESIGNATED_ADMIN_NUMBER)}@s.whatsapp.net`);
  }
  if (env.PRIMARY_ADMIN_NUMBER) {
    const raw = env.PRIMARY_ADMIN_NUMBER.trim();
    adminEndpoints.add(raw.includes('@') ? raw : `${normalizeUserId(raw)}@s.whatsapp.net`);
  }

  for (const adminJid of adminEndpoints) {
    try {
      await sock.sendMessage(adminJid, { text });
    } catch (err: any) {
      console.warn(`[WARN] [ADMIN ALERT] Failed to send alert to ${adminJid}:`, err.message);
    }
  }
}

/**
 * Periodically cleans expired timestamps to prevent unbounded memory growth on long-running bot instances.
 */
export function cleanupRouterMaps(now: number = Date.now()): { cleanedRequests: number; cleanedWarnings: number; cleanedAdminAlerts: number } {
  let cleanedRequests = 0;
  for (const [key, timestamps] of requestTracker.entries()) {
    const recent = timestamps.filter(ts => (now - ts) < 5 * 60 * 1000);
    if (recent.length === 0) {
      requestTracker.delete(key);
      cleanedRequests++;
    } else {
      requestTracker.set(key, recent);
    }
  }

  let cleanedWarnings = 0;
  for (const [key, ts] of warningTracker.entries()) {
    if (now - ts > 10 * 60 * 1000) {
      warningTracker.delete(key);
      cleanedWarnings++;
    }
  }

  let cleanedAdminAlerts = 0;
  for (const [key, ts] of adminNotificationTracker.entries()) {
    if (now - ts > ADMIN_ALERT_COOLDOWN_MS) {
      adminNotificationTracker.delete(key);
      cleanedAdminAlerts++;
    }
  }

  return { cleanedRequests, cleanedWarnings, cleanedAdminAlerts };
}

const routerCleanupInterval = setInterval(() => {
  cleanupRouterMaps();
}, 15 * 60 * 1000);
routerCleanupInterval.unref?.();

/**
 * Safely extracts the actual phone number / identifier from Baileys JID formats.
 */
const extractRealNumber = (msg: proto.IWebMessageInfo): string | null => {
  let rawJid = msg.key.participant || msg.key.remoteJid;
  if (!rawJid) return null;

  // Strips off device ID (:1) and domain (@s.whatsapp.net or @lid)
  if (rawJid.includes(':')) rawJid = rawJid.split(':')[0];
  if (rawJid.includes('@')) rawJid = rawJid.split('@')[0];

  return rawJid;
};

/**
 * Universally unwraps documentMessage from any WhatsApp message wrapper:
 * - Direct documentMessage
 * - documentWithCaptionMessage (modern WhatsApp upload with caption)
 * - ephemeralMessage
 * - viewOnceMessage / viewOnceMessageV2
 */
export function extractDocumentMessage(msg: proto.IWebMessageInfo): proto.Message.IDocumentMessage | undefined {
  const m = msg.message;
  if (!m) return undefined;
  return (
    m.documentMessage ||
    m.documentWithCaptionMessage?.message?.documentMessage ||
    m.ephemeralMessage?.message?.documentMessage ||
    m.ephemeralMessage?.message?.documentWithCaptionMessage?.message?.documentMessage ||
    m.viewOnceMessage?.message?.documentMessage ||
    m.viewOnceMessage?.message?.documentWithCaptionMessage?.message?.documentMessage ||
    m.viewOnceMessageV2?.message?.documentMessage ||
    m.viewOnceMessageV2?.message?.documentWithCaptionMessage?.message?.documentMessage
  ) || undefined;
}

const processedMessageIds = new Set<string>();

/**
 * Checks if a message ID has already been handled.
 * Prevents duplicate processing when offline messages are flushed on reconnect.
 */
export function isMessageAlreadyProcessed(msgId: string): boolean {
  if (processedMessageIds.has(msgId)) return true;
  processedMessageIds.add(msgId);
  if (processedMessageIds.size > 5000) {
    const oldest = processedMessageIds.values().next().value;
    if (oldest) processedMessageIds.delete(oldest);
  }
  return false;
}

export async function handleIncomingMessage(sock: WASocket, msg: proto.IWebMessageInfo): Promise<void> {
  const from = msg.key.remoteJid;
  const msgId = msg.key.id;

  if (!from || !msgId || msg.key.fromMe) return;

  // Deduplication Guard: Ignore redelivered messages from reconnect queue flushes
  if (isMessageAlreadyProcessed(msgId)) {
    return;
  }

  const senderLid = extractRealNumber(msg) || 'UNKNOWN_SENDER';
  const isGroup = from.endsWith('@g.us');
  const isDirectChat = !isGroup;

  // --------------------------------------------------------------------------
  // 0. PROTOCOL REVOKE INTERCEPTOR ("Delete for Everyone")
  // --------------------------------------------------------------------------
  const isRevoke = msg.message?.protocolMessage?.type === 0;
  if (isRevoke) {
    const targetRevokeId = msg.message?.protocolMessage?.key?.id;
    if (targetRevokeId) {
      await adsproBuffer.handleMessageRevoke(targetRevokeId);
    }
    return;
  }

  // --------------------------------------------------------------------------
  // 1. EXTRACT DOCUMENT & TEXT PAYLOADS (Supports documentWithCaptionMessage)
  // --------------------------------------------------------------------------
  const docMessage = extractDocumentMessage(msg);
  const isDocument = !!docMessage;
  const rawMessageText = (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    docMessage?.caption ||
    ""
  ).trim();


  // --------------------------------------------------------------------------
  // 1.5 ADMIN COMMANDS & IN-CHAT GROUP ENABLING
  // --------------------------------------------------------------------------
  const trimmedLower = rawMessageText.toLowerCase().trim();

  // Admin In-Chat & Remote Group Enable Command:
  // 1. Remote DM from admin: .enable <groupJid>
  // 2. In-group command: .enable, .adspro enable, .adspro start
  if (trimmedLower.startsWith('.enable') || trimmedLower.startsWith('.adspro enable') || trimmedLower.startsWith('.adspro start')) {
    const isAdmin = isPrimaryAdmin(senderLid);
    const parts = trimmedLower.split(/\s+/);
    const targetGroupJid = parts.find(p => p.includes('@g.us')) || (parts.length >= 2 && parts[parts.length - 1].endsWith('@g.us') ? parts[parts.length - 1] : undefined);

    if (targetGroupJid && isAdmin) {
      await registerAuthorizedGroup(targetGroupJid);
      const groupName = getGroupTitle(targetGroupJid);
      await sock.sendMessage(from, {
        text: `*GROUP AUTHORIZED*\nGroup *${groupName || targetGroupJid}* (\`${targetGroupJid}\`) has been permanently authorized in Firestore. Commercial print jobs will now be processed automatically.`
      });
      return;
    }

    if (isGroup) {
      await registerAuthorizedGroup(from);
      await sock.sendMessage(from, {
        text: `*PRINT AUTOMATION ACTIVATED*\nThis group is now authorized. You can now send PDF flyers, visiting cards, and stickers with specs to log orders.`
      });
      return;
    }

    if (!targetGroupJid && isDirectChat && isAdmin) {
      await sock.sendMessage(from, {
        text: `*Usage to authorize a group remotely:*\n*.enable <groupJid>*\nExample: *.enable 120363412514415436@g.us*`
      });
      return;
    }
  }

  // Admin In-Chat User Authorization: .auth <id> or reply .auth
  if (trimmedLower.startsWith('.auth')) {
    const isAdmin = isPrimaryAdmin(senderLid);
    if (isAdmin) {
      let targetId = trimmedLower.replace('.auth', '').trim().replace(/[^0-9]/g, '');
      const quotedSender = msg.message?.extendedTextMessage?.contextInfo?.participant;
      if (!targetId && quotedSender) {
        targetId = normalizeUserId(quotedSender);
      }

      if (targetId) {
        await authorizeUserInFirestore(targetId, 'Admin Approved via WhatsApp Chat');
        await sock.sendMessage(from, {
          text: `*USER AUTHORIZED*\nUser *${targetId}* has been approved and registered in Firestore.`
        });
        return;
      } else {
        await sock.sendMessage(from, {
          text: `*Usage:* Reply to a user with *.auth* or type *.auth <number/LID>*`
        });
        return;
      }
    }
  }

  // Admin List Groups Command: .groups
  if (trimmedLower === '.groups' && isPrimaryAdmin(senderLid)) {
    const groups = getAuthorizedGroups();
    const groupListStr = groups.length > 0 
      ? groups.map((g, i) => `${i + 1}. ${g}`).join('\n')
      : (env.ALLOW_ALL_GROUPS ? 'All Groups Mode (Open Access)' : 'None');
    await sock.sendMessage(from, {
      text: `*AUTHORIZED GROUPS INVENTORY (${groups.length}):*\n${groupListStr}`
    });
    return;
  }

  // Admin Bucket Cleanup Command: .cleanbucket [dryrun|run|status]
  if ((trimmedLower.startsWith('.cleanbucket') || trimmedLower.startsWith('.adspro cleanbucket')) && isPrimaryAdmin(senderLid)) {
    const isExecute = trimmedLower.includes('run') && !trimmedLower.includes('dryrun');
    await sock.sendMessage(from, {
      text: `*STORAGE SCAN IN PROGRESS*\nAnalyzing flyer bucket files against ${env.BUCKET_RETENTION_DAYS}-day retention threshold...`
    });

    try {
      const result = await cleanExpiredFlyers({
        dryRun: !isExecute,
        maxAgeDays: env.BUCKET_RETENTION_DAYS
      });

      const mbFreed = (result.bytesFreed / 1024 / 1024).toFixed(2);
      const actionText = isExecute
        ? `*STORAGE PURGE COMPLETE*\n\n` +
          `Deleted: *${result.deletedCount}* files\n` +
          `Freed Space: *${mbFreed} MB*\n` +
          `Duration: *${result.durationMs}ms*`
        : `*STORAGE RETENTION SCAN (DRY-RUN)*\n\n` +
          `Total Scanned: *${result.totalScanned}* files\n` +
          `Older than ${env.BUCKET_RETENTION_DAYS} Days: *${result.expiredCount}* files\n` +
          `Estimated Space Savings: *${mbFreed} MB*\n\n` +
          `_To permanently delete these files, reply:_\n*.cleanbucket run*`;

      await sock.sendMessage(from, { text: actionText });
    } catch (err: any) {
      await sock.sendMessage(from, {
        text: `*STORAGE CLEANUP ERROR*\n${err.message}`
      });
    }
    return;
  }

  // --------------------------------------------------------------------------
  // 2. SECURITY GATE & RATE LIMITING (For Direct 1-on-1 Chats)
  // --------------------------------------------------------------------------
  if (isDirectChat) {
    // Check if the direct user is authorized (with group-member auto-inheritance)
    const isAuthorized = await isAuthorizedUser(senderLid, sock);
    if (!isAuthorized) {
      console.warn(`\n[SECURITY] Blocked unauthorized direct user: ${senderLid}`);
      await sock.sendMessage(from, {
        text: `*ACCESS DENIED*\nYour account (*${senderLid}*) is not registered in the authorized system users. An administrator has been notified.`
      });

      // Notify Admins (+91 8921156958 and PRIMARY_ADMIN_NUMBER) with instant one-tap approval command
      const now = Date.now();
      const lastAdminAlert = adminNotificationTracker.get(senderLid) || 0;
      if (now - lastAdminAlert > ADMIN_ALERT_COOLDOWN_MS) {
        adminNotificationTracker.set(senderLid, now);
        const alertText = 
          `*ADSPRO USER ACCESS REQUEST*\n` +
          `User *${senderLid}* attempted to message the bot directly.\n\n` +
          `*To approve immediately, reply:*\n*.auth ${senderLid}*`;
        await notifyAdmins(sock, alertText);
        console.log(`[INFO] [ALERT] Dispatched access request alert for user ${senderLid} to admins.`);
      } else {
        console.log(`[INFO] [ALERT] Suppressed duplicate admin alert for user ${senderLid} (cooldown: 2 hours).`);
      }
      return;
    }

    // Rate limiter
    const now = Date.now();
    const userTimestamps = requestTracker.get(senderLid) || [];
    const recentRequests = userTimestamps.filter(ts => (now - ts) < RATE_LIMIT_WINDOW_MS);

    if (recentRequests.length >= MAX_REQUESTS_PER_WINDOW) {
      const lastWarningSent = warningTracker.get(senderLid) || 0;
      if ((now - lastWarningSent) > RATE_LIMIT_WINDOW_MS) {
        warningTracker.set(senderLid, now);
        console.warn(`[RATE LIMIT] Throttling active for direct chat user ${senderLid}`);
        await sock.sendMessage(from, {
          text: `*RATE LIMIT NOTICE*\nPlease pause for 1 minute to allow pending jobs to process.`
        });
      }
      return;
    }

    recentRequests.push(now);
    requestTracker.set(senderLid, recentRequests);

    // Direct Chat Command Handler (Greetings & Help)
    const lowerText = rawMessageText.toLowerCase().trim();
    if (!isDocument && ['hi', 'hello', 'hey', 'help', 'start'].includes(lowerText)) {
      const helpMessage =
        `*ADSPRO PRINT AUTOMATION GUIDE*\n\n` +
        `Ready to receive print orders. Usage:\n\n` +
        `1. *Upload / Forward Flyer:* Send the PDF flyer (e.g. *HILITE FLAYER PROMO 18 TO 20.pdf*).\n` +
        `2. *Provide Specifications:* Reply with size & copy count (e.g. *A4 Both side 6000 copies* or *23X33 4 page 5000 copy*).\n\n` +
        `*Safety Window:* Orders are buffered for 2 minutes to allow multiple files or deletes before saving to Google Sheets.`;

      await sock.sendMessage(from, { text: helpMessage });
      return;
    }
  }

  // --------------------------------------------------------------------------
  // 3. GROUP FILTERING (Multi-Group, All Groups, or Whitelisted Groups)
  // --------------------------------------------------------------------------
  if (isGroup) {
    const authorizedGroups = getAuthorizedGroups();
    const isTargetAdsproGroup = Boolean(
      env.ALLOW_ALL_GROUPS ||
      authorizedGroups.length === 0 ||
      authorizedGroups.includes(from)
    );

    if (!isTargetAdsproGroup) {
      // 100% SILENT IN CLIENT GROUP (Never disturb client WhatsApp group with error messages)
      const groupTitle = getGroupTitle(from);
      console.warn(`[WARN] [GROUP] Document received in unauthorized group "${groupTitle || from}" (${from}).`);

      // If document was uploaded, alert Admins (+91 8921156958 & PRIMARY_ADMIN_NUMBER) with Group JID
      if (isDocument && docMessage) {
        const now = Date.now();
        const lastGroupAlert = adminNotificationTracker.get(`group_${from}`) || 0;
        const GROUP_ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

        if (now - lastGroupAlert > GROUP_ALERT_COOLDOWN_MS) {
          adminNotificationTracker.set(`group_${from}`, now);
          const fileName = docMessage.fileName || docMessage.title || 'document.pdf';
          const captionText = docMessage.caption || rawMessageText || 'None';

          const groupAlertText =
            `*GROUP ACCESS REQUEST*\n` +
            `A commercial print file was uploaded in an unauthorized group:\n\n` +
            `Group Name: ${groupTitle ? `"${groupTitle}"` : 'WhatsApp Group'}\n` +
            `Group JID: \`${from}\`\n` +
            `Sender: ${senderLid}\n` +
            `File: "${fileName}"\n` +
            `Caption: "${captionText}"\n\n` +
            `To activate this group permanently, reply:\n` +
            `*.enable ${from}*`;

          await notifyAdmins(sock, groupAlertText);
          console.log(`[INFO] [ADMIN] Dispatched group activation request for ${from} to admins.`);
        }
      }

      return;
    }

    if (!discoveredGroups.has(from)) {
      discoveredGroups.add(from);
      console.log(`[INFO] [GROUP] Active group order from JID: "${from}" | Sender: ${senderLid}`);
    }
  }

  // --------------------------------------------------------------------------
  // 4. UNIFIED ADSPRO PIPELINE (Direct Chats + Groups)
  // --------------------------------------------------------------------------

  // A. Handle Incoming PDF Document
  if (isDocument && docMessage) {
    const fileName = docMessage.fileName || docMessage.title || 'unnamed_document.pdf';
    const fileLength = typeof docMessage.fileLength === 'number' ? docMessage.fileLength : Number(docMessage.fileLength) || undefined;
    const pageCount = docMessage.pageCount || undefined;
    const thumbnail = docMessage.jpegThumbnail ? Buffer.from(docMessage.jpegThumbnail) : undefined;
    const caption = docMessage.caption && docMessage.caption.trim().length > 0 ? docMessage.caption.trim() : undefined;

    // 0. SMART TIERED FILE INGESTION (Zero-Drop Architecture for up to 2GB WhatsApp documents)
    // Files <= MAX_DOWNLOAD_THRESHOLD (default 150MB): Download & high-res Page 1 worker render
    // Files > MAX_DOWNLOAD_THRESHOLD (e.g. 150MB - 2GB): Fast-path using embedded WhatsApp jpegThumbnail & pageCount
    const maxDownloadMb = env.MAX_PDF_DOWNLOAD_MB || 150;
    const MAX_DOWNLOAD_THRESHOLD = maxDownloadMb * 1024 * 1024;
    const hasThumbnail = Boolean(thumbnail && thumbnail.length > 0);
    const isHeavyFile = Boolean(fileLength && fileLength > MAX_DOWNLOAD_THRESHOLD && hasThumbnail);

    if (isHeavyFile) {
      console.log(`[INFO] [FAST-PATH] "${fileName}" (${(fileLength! / 1024 / 1024).toFixed(1)}MB > ${maxDownloadMb}MB). Bypassing heavy binary download; utilizing embedded WhatsApp thumbnail & metadata.`);
    }

    // 1. INSTANT REGISTRATION (< 1ms): Always register document in buffer so any captions find it
    const { isBurstContinuation } = await adsproBuffer.handleIncomingDocument(
      from,
      senderLid,
      msgId,
      {
        fileName,
        fileLength,
        pageCount,
        thumbnail,
        caption
      },
      isDirectChat
    );

    // 2. TIERED MEDIA RESOLUTION
    if (isHeavyFile) {
      // Fast-path: Instantly mark media ready using the WhatsApp thumbnail and metadata (0 MB download RAM overhead)
      adsproBuffer.updateDocumentMedia(msgId, {
        page1Image: thumbnail,
        pageCount: pageCount || 1
      });
      console.log(`[INFO] [BUFFER] Heavy file "${fileName}" staged via embedded thumbnail (${(fileLength! / 1024 / 1024).toFixed(1)} MB, Pages: ${pageCount || 1})`);
      return;
    }

    // Standard background download & Page 1 render for files <= 150MB (or heavy files without thumbnail)
    if (fileName.toLowerCase().endsWith('.pdf') || docMessage.mimetype?.includes('pdf')) {
      (async () => {
        try {
          const actionMsg = isBurstContinuation
            ? `metadata extraction (burst page)`
            : `Page 1 render (offloaded to worker thread)`;
          console.log(`[INFO] [DOWNLOAD] Started background download & ${actionMsg} for "${fileName}" (MsgId: ${msgId})...`);

          const normalizedMsg: proto.IWebMessageInfo = {
            ...msg,
            message: {
              ...msg.message,
              documentMessage: docMessage
            }
          };
          const buffer = await downloadMediaMessage(
            normalizedMsg,
            'buffer',
            {},
            {
              logger: pino({ level: 'silent' }) as any,
              reuploadRequest: sock.updateMediaMessage
            }
          ) as Buffer;

          if (Buffer.isBuffer(buffer) && buffer.length > 0) {
            const { title: parsedTitle, pageCount: parsedPages } = await extractPdfMetadata(buffer);

            // Only render Page 1 to PNG if this is the primary/cover document!
            // Secondary burst pages (pages 2, 3, 4) do NOT require PNG rasterization.
            let page1: Buffer | null = null;
            if (!isBurstContinuation) {
              page1 = await renderPdfPage1ToPng(buffer);
            } else {
              console.log(`[INFO] [BURST] Skipped PNG rasterization for secondary burst page "${fileName}". Page count: ${parsedPages}`);
            }

            adsproBuffer.updateDocumentMedia(msgId, {
              page1Image: page1 || thumbnail,
              pageCount: parsedPages || pageCount,
              pdfTitle: parsedTitle
            });
            console.log(`[INFO] [DOWNLOAD] "${fileName}" ready (${(buffer.length / 1024 / 1024).toFixed(2)} MB, Title: "${parsedTitle || 'none'}")`);
          } else {
            adsproBuffer.updateDocumentMedia(msgId, { page1Image: thumbnail });
          }
        } catch (dlErr: any) {
          console.warn(`[WARN] [DOWNLOAD] Background media processing failed for "${fileName}". Falling back to thumbnail:`, dlErr?.message);
          adsproBuffer.updateDocumentMedia(msgId, { page1Image: thumbnail });
        }
      })();
    }

    return;
  }


  // B. Handle Incoming Specification Text Message
  if (rawMessageText) {
    const contextInfo =
      msg.message?.extendedTextMessage?.contextInfo ||
      msg.message?.imageMessage?.contextInfo ||
      msg.message?.documentMessage?.contextInfo ||
      msg.message?.documentWithCaptionMessage?.message?.documentMessage?.contextInfo;
    const quotedStanzaId = contextInfo?.stanzaId || undefined;


    await adsproBuffer.handleIncomingText(
      from,
      senderLid,
      rawMessageText,
      quotedStanzaId,
      isDirectChat
    );
    return;
  }
}