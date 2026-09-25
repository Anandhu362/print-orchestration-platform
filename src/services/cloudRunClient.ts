import { GoogleAuth } from 'google-auth-library';
import { JobDispatchPayload, JobProcessResult } from '../shared/types/jobPayload';

export class CloudRunWorkerClient {
  private auth: GoogleAuth;
  private workerUrl: string;
  private isEnabled: boolean;
  private timeoutMs: number;

  constructor() {
    this.auth = new GoogleAuth();
    this.workerUrl = process.env.CLOUD_RUN_WORKER_URL || '';
    this.isEnabled = process.env.USE_CLOUD_RUN_WORKER === 'true' && Boolean(this.workerUrl);
    this.timeoutMs = parseInt(process.env.CLOUD_RUN_TIMEOUT_MS || '300000', 10);
  }

  public isCloudRunConfigured(): boolean {
    return this.isEnabled;
  }

  public async dispatchJob(payload: JobDispatchPayload): Promise<JobProcessResult> {
    if (!this.isEnabled) {
      return {
        success: false,
        jobId: payload.jobId,
        error: 'Cloud Run worker is disabled or CLOUD_RUN_WORKER_URL is missing.'
      };
    }

    try {
      console.log(`[INFO] [CLOUD RUN] Sending Job [${payload.jobId}] to ${this.workerUrl}...`);
      const client = await this.auth.getIdTokenClient(this.workerUrl);

      const response = await client.request<JobProcessResult>({
        url: `${this.workerUrl.replace(/\/$/, '')}/process-job`,
        method: 'POST',
        data: payload,
        timeout: this.timeoutMs
      });

      if (response.status === 200 && response.data) {
        console.log(`[INFO] [CLOUD RUN] Job [${payload.jobId}] processed in Cloud Run: "${response.data.shopName}" (${response.data.workDetails})`);
        return response.data;
      }

      return {
        success: false,
        jobId: payload.jobId,
        error: `Cloud Run worker returned HTTP status ${response.status}`
      };
    } catch (err: any) {
      console.warn(`[WARN] [CLOUD RUN] Failed to dispatch Job [${payload.jobId}] to Cloud Run:`, err?.message);
      return {
        success: false,
        jobId: payload.jobId,
        error: err?.message || 'Unknown Cloud Run Client Error'
      };
    }
  }
}

export const cloudRunClient = new CloudRunWorkerClient();
