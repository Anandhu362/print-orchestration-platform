import cron, { ScheduledTask } from 'node-cron';
import { flyerBucket } from '../database/firebase';
import { env } from '../config/environment';

export interface BucketCleanResult {
  totalScanned: number;
  expiredCount: number;
  deletedCount: number;
  bytesFreed: number;
  dryRun: boolean;
  durationMs: number;
  errors: Array<{ fileName: string; error: string }>;
}

const TARGET_PREFIX = 'flyers/';
const BATCH_SIZE = 10;
let scheduledCronTask: ScheduledTask | null = null;

/**
 * Scans and prunes flyer assets in Cloud Storage older than the retention threshold.
 * 
 * CRITICAL PRECAUTIONS ENFORCED:
 * 1. Strictly restricted to 'flyers/' prefix: Never touches Cloud Run deployment tars in run-sources-*.
 * 2. Strict 14-day grace window: Preserves current and previous week's orders for auditing.
 * 3. Throttled batch processing: 10 files per batch to prevent Node.js event loop lag and socket exhaustion.
 * 4. Error containment: Individual deletion errors are caught and logged without aborting the run.
 */
export async function cleanExpiredFlyers(options: {
  dryRun?: boolean;
  maxAgeDays?: number;
} = {}): Promise<BucketCleanResult> {
  const startTime = Date.now();
  const dryRun = Boolean(options.dryRun);
  const maxAgeDays = typeof options.maxAgeDays === 'number' ? options.maxAgeDays : env.BUCKET_RETENTION_DAYS;
  const cutoffTimestamp = startTime - (maxAgeDays * 24 * 60 * 60 * 1000);

  const result: BucketCleanResult = {
    totalScanned: 0,
    expiredCount: 0,
    deletedCount: 0,
    bytesFreed: 0,
    dryRun,
    durationMs: 0,
    errors: []
  };

  console.log(`\n[INFO] [STORAGE] [GC START] ${dryRun ? 'DRY-RUN SCAN' : 'PURGE RUN'} | Bucket: gs://${flyerBucket.name}/${TARGET_PREFIX} | Retention: ${maxAgeDays} days`);

  try {
    const [files] = await flyerBucket.getFiles({
      prefix: TARGET_PREFIX,
      autoPaginate: true
    });

    result.totalScanned = files.length;
    const expiredFiles: typeof files = [];

    for (const file of files) {
      // PRECAUTION 1: Assertion guard - refuse to touch any file outside flyers/
      if (!file.name || !file.name.startsWith(TARGET_PREFIX)) {
        console.error(`[ERROR] [SECURITY] File "${file.name}" is outside "${TARGET_PREFIX}". Immediate skip.`);
        continue;
      }

      // Skip root folder directory markers if any
      if (file.name === TARGET_PREFIX || file.name.endsWith('/')) {
        continue;
      }

      const createdTime = file.metadata.timeCreated || file.metadata.updated;
      const fileCreatedMs = createdTime ? Date.parse(createdTime) : 0;

      // Never delete files with missing or unparseable timestamps
      if (fileCreatedMs <= 0) {
        continue;
      }

      if (fileCreatedMs < cutoffTimestamp) {
        expiredFiles.push(file);
        result.expiredCount++;
        result.bytesFreed += Number(file.metadata.size || 0);
      }
    }

    console.log(`[INFO] [STORAGE] Scanned ${result.totalScanned} files. Identified ${result.expiredCount} files older than ${maxAgeDays} days (${(result.bytesFreed / 1024 / 1024).toFixed(2)} MB).`);

    if (dryRun) {
      console.log(`[INFO] [STORAGE] Dry-run completed. 0 files deleted.`);
      result.durationMs = Date.now() - startTime;
      return result;
    }

    // PRECAUTION 3: Batch deletion to prevent connection saturation
    for (let i = 0; i < expiredFiles.length; i += BATCH_SIZE) {
      const batch = expiredFiles.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (file) => {
          try {
            // Re-verify safety guard immediately before execution
            if (!file.name.startsWith(TARGET_PREFIX)) {
              throw new Error(`Safety violation: file ${file.name} does not match prefix ${TARGET_PREFIX}`);
            }
            await file.delete();
            result.deletedCount++;
          } catch (err: any) {
            console.warn(`[WARN] [STORAGE] Failed to delete "${file.name}":`, err.message);
            result.errors.push({ fileName: file.name, error: err.message });
          }
        })
      );
    }

    result.durationMs = Date.now() - startTime;
    console.log(`[INFO] [STORAGE] Pruned ${result.deletedCount}/${result.expiredCount} files in ${result.durationMs}ms. Freed ${(result.bytesFreed / 1024 / 1024).toFixed(2)} MB.\n`);
    return result;

  } catch (scanErr: any) {
    result.durationMs = Date.now() - startTime;
    console.error(`[ERROR] [STORAGE] Scan/cleanup failed:`, scanErr.message);
    throw scanErr;
  }
}

/**
 * Ensures Google Cloud Storage native Object Lifecycle Management is active on the bucket.
 * This runs natively inside GCS at 0 compute cost and 0 memory consumption.
 */
export async function ensureBucketLifecycleRule(retentionDays: number = 14): Promise<boolean> {
  try {
    const [metadata] = await flyerBucket.getMetadata();
    const existingRules: any[] = metadata.lifecycle?.rule || [];

    // Check if an equivalent Delete rule on flyers/ already exists
    const hasFlyerDeleteRule = existingRules.some((r: any) => 
      r.action?.type === 'Delete' &&
      r.condition?.age === retentionDays &&
      Array.isArray(r.condition?.matchesPrefix) &&
      r.condition.matchesPrefix.includes(TARGET_PREFIX)
    );

    if (hasFlyerDeleteRule) {
      console.log(`[INFO] [STORAGE] Native 14-day deletion rule already active on gs://${flyerBucket.name}/${TARGET_PREFIX}`);
      return true;
    }

    console.log(`[INFO] [STORAGE] Configuring native ${retentionDays}-day Object Lifecycle Management on gs://${flyerBucket.name}/${TARGET_PREFIX}...`);
    
    // Add rule with strict flyers/ prefix restriction
    await flyerBucket.addLifecycleRule({
      action: {
        type: 'Delete'
      },
      condition: {
        age: retentionDays,
        matchesPrefix: [TARGET_PREFIX]
      }
    });

    console.log(`[INFO] [STORAGE] Successfully applied native ${retentionDays}-day lifecycle rule to gs://${flyerBucket.name}/${TARGET_PREFIX}`);
    return true;
  } catch (err: any) {
    // If service account lacks storage.buckets.update permission, fallback safely to the in-app cron
    console.warn(`[WARN] [STORAGE] Native lifecycle rule registration notice: ${err.message}. Node.js in-app weekly cron will handle scheduled prunes.`);
    return false;
  }
}

/**
 * Bootstraps the automated weekly Sunday cron job.
 * Default schedule: Every Sunday at 03:00 AM GST (UTC+4 -> 23:00 UTC Saturday).
 */
export function initBucketCleanupCron(): void {
  if (!env.ENABLE_BUCKET_CLEANUP_CRON) {
    console.log('[INFO] [CRON] In-app bucket cleanup cron is disabled (ENABLE_BUCKET_CLEANUP_CRON=false).');
    return;
  }

  if (scheduledCronTask) {
    console.log('[INFO] [CRON] Scheduled cleanup task already active.');
    return;
  }

  // Crontab: '0 3 * * 0' (Every Sunday at 03:00 AM)
  const cronExpression = '0 3 * * 0';
  const timezone = env.TZ || 'Asia/Dubai';

  scheduledCronTask = cron.schedule(
    cronExpression,
    async () => {
      console.log(`\n[INFO] [CRON] Executing automated 14-day flyer bucket cleanup at 03:00 AM (${timezone})...`);
      try {
        const result = await cleanExpiredFlyers({ maxAgeDays: env.BUCKET_RETENTION_DAYS });
        console.log(`[INFO] [CRON] Cleaned ${result.deletedCount} flyer files. Freed ${(result.bytesFreed / 1024 / 1024).toFixed(2)} MB.`);
      } catch (cronErr: any) {
        console.error('[ERROR] [CRON] Scheduled bucket cleanup error:', cronErr.message);
      }
    },
    {
      timezone
    }
  );

  console.log(`[INFO] [CRON] Scheduled weekly flyer cleanup cron active ('${cronExpression}' in ${timezone}).`);
}

/**
 * Stops the scheduled cron task (useful for unit testing and graceful shutdowns).
 */
export function stopBucketCleanupCron(): void {
  if (scheduledCronTask) {
    scheduledCronTask.stop();
    scheduledCronTask = null;
    console.log('[INFO] [CRON] Stopped weekly flyer cleanup cron task.');
  }
}
