import express from 'express';
import { env } from './config/environment';
import { connectToWhatsApp } from './whatsapp/client';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { initBucketCleanupCron, ensureBucketLifecycleRule } from './cron/bucketCleaner';

const app = express();

// Middleware to parse incoming JSON payloads (Best practice for Cloud Run APIs)
app.use(express.json());

// Health Check Routes for Container & Cloud Lifecycle Probes
const healthPayload = () => ({
    status: 'healthy',
    platform: 'ADSPRO-Print-Automation',
    agent: 'Dual Mode (Group + Direct Chat)',
    gitCommit: process.env.GIT_COMMIT_SHA || 'unknown',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
});

app.get(['/', '/health', '/healthz'], (req, res) => {
    res.status(200).json(healthPayload());
});

/**
 * Pings the Gemini API to verify the API key and connection are valid
 */
async function testAIConnection() {
    try {
        const ai = new GoogleGenerativeAI(env.GEMINI_API_KEY);
        const model = ai.getGenerativeModel({ model: 'gemini-2.5-flash' });
        
        // Send a microscopic prompt to test authentication
        await model.generateContent('ping');
        console.log('[INFO] [AI] Generative model connection verified (gemini-2.5-flash)');
    } catch (error: any) {
        console.warn('[WARN] [AI] Local health probe deferred (transient network):', error?.message || 'Network unreachable');
        console.log('[INFO] [AI] Heavy multimodal processing will be offloaded to Cloud Run.');
    }
}

app.listen(env.PORT, async () => {
    console.log(`[INFO] [SERVER] Web backend operational on port ${env.PORT}`);
    
    // Verify AI health before booting the rest of the application
    await testAIConnection();

    // Initialize automated 14-day flyer bucket cleanup cron & GCS native lifecycle rule
    initBucketCleanupCron();
    ensureBucketLifecycleRule().catch(err =>
        console.warn('[WARN] [STORAGE] Native GCS lifecycle rule notice:', err.message)
    );
    
    // Bootstrap the WhatsApp connection pipeline 
    // (Note: This also initializes the Reminder Cron Engine once the socket connects)
    connectToWhatsApp().catch((error) => {
        console.error('[ERROR] [SERVER] Fatal error during WhatsApp client initialization:', error);
    });
});