import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Load environmental parameters
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

interface Environment {
    NODE_ENV: 'development' | 'production';
    PORT: number;
    WA_SESSION_ID: string;
    FIREBASE_PROJECT_ID: string;
    FIREBASE_DATABASE_URL: string;
    // Added the path to the interface so firebase.ts can use it
    GCP_SERVICE_ACCOUNT_PATH: string; 
    GCP_SERVICE_ACCOUNT_KEY: Record<string, any>;
    GOOGLE_SHEET_ID: string;
    GEMINI_API_KEY: string;
    DEFAULT_REMINDER_DAYS: number;
    TZ: string;
    PRIMARY_ADMIN_NUMBER: string;
    ADSPRO_SHEET_ID: string;
    ADSPRO_GROUP_JID: string;
    ADSPRO_GROUP_JIDS: string[];
    ALLOW_ALL_GROUPS: boolean;
    ALLOW_ALL_DIRECT: boolean;
    AUTHORIZED_SENDERS: string[];
    BUCKET_RETENTION_DAYS: number;
    ENABLE_BUCKET_CLEANUP_CRON: boolean;
    MAX_PDF_DOWNLOAD_MB: number;
}

function validateEnv(): Environment {
    // We now require the exact same fields in both local and production
    const requiredFields: (keyof NodeJS.ProcessEnv)[] = [
        'FIREBASE_PROJECT_ID', 
        'FIREBASE_DATABASE_URL', 
        'WA_SESSION_ID', 
        'GOOGLE_SHEET_ID', 
        'ADSPRO_SHEET_ID',
        'GEMINI_API_KEY', 
        'TZ'
    ];

    for (const field of requiredFields) {
        if (!process.env[field]) {
            throw new Error(`[FATAL] Configuration Error: System environment variable "${field}" is missing.`);
        }
    }

    let parsedServiceAccountKey: Record<string, any> = {};
    const saPath = process.env.GCP_SERVICE_ACCOUNT_PATH;
    const saKeyEnv = process.env.GCP_SERVICE_ACCOUNT_KEY || process.env.GCP_SA_KEY;
    
    if (saKeyEnv && saKeyEnv.trim().length > 0) {
        try {
            const rawStr = saKeyEnv.trim();
            // Handle base64 encoded JSON or raw JSON string
            const jsonStr = rawStr.startsWith('{') ? rawStr : Buffer.from(rawStr, 'base64').toString('utf8');
            parsedServiceAccountKey = JSON.parse(jsonStr);
        } catch (err: any) {
            throw new Error(`[FATAL] Configuration Error: Failed to parse GCP_SERVICE_ACCOUNT_KEY environment variable. Details: ${err.message}`);
        }
    } else if (saPath && saPath.trim().length > 0) {
        try {
            const filePath = path.resolve(process.cwd(), saPath);
            if (!fs.existsSync(filePath)) {
                throw new Error(`Service account file not found at path: ${filePath}`);
            }
            parsedServiceAccountKey = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (error: any) {
            throw new Error(`[FATAL] Configuration Error: Failed to parse key file at ${saPath}. Details: ${error.message}`);
        }
    } else {
        throw new Error(`[FATAL] Configuration Error: Missing Google Cloud service account credentials. Provide either GCP_SERVICE_ACCOUNT_PATH (file path) or GCP_SERVICE_ACCOUNT_KEY (JSON string).`);
    }

    process.env.TZ = process.env.TZ;

    const rawGroupJid = (process.env.ADSPRO_GROUP_JID || '').trim();
    const allowAllGroups = 
        process.env.ALLOW_ALL_GROUPS === 'true' || 
        rawGroupJid === '*' || 
        rawGroupJid.toUpperCase() === 'ALL' || 
        rawGroupJid === '';

    const adsproGroupJids = rawGroupJid
        .split(',')
        .map(j => j.trim())
        .filter(j => j && j !== '*' && j.toUpperCase() !== 'ALL');

    const allowAllDirect = process.env.ALLOW_ALL_DIRECT === 'true' || process.env.DIRECT_CHAT_ACCESS === 'ALL';

    const authorizedSenders = (process.env.AUTHORIZED_SENDERS || '')
        .split(',')
        .map(s => s.trim().replace(/[^0-9]/g, ''))
        .filter(Boolean);

    return {
        NODE_ENV: (process.env.NODE_ENV as any) || 'development',
        PORT: parseInt(process.env.PORT || '8080', 10),
        WA_SESSION_ID: process.env.WA_SESSION_ID!,
        FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID!,
        FIREBASE_DATABASE_URL: process.env.FIREBASE_DATABASE_URL!,
        GCP_SERVICE_ACCOUNT_PATH: process.env.GCP_SERVICE_ACCOUNT_PATH || '',
        GCP_SERVICE_ACCOUNT_KEY: parsedServiceAccountKey,
        GOOGLE_SHEET_ID: process.env.GOOGLE_SHEET_ID!,
        GEMINI_API_KEY: process.env.GEMINI_API_KEY!,
        PRIMARY_ADMIN_NUMBER: process.env.PRIMARY_ADMIN_NUMBER || '',
        DEFAULT_REMINDER_DAYS: parseInt(process.env.DEFAULT_REMINDER_DAYS || '2', 10),
        TZ: process.env.TZ!,
        ADSPRO_SHEET_ID: process.env.ADSPRO_SHEET_ID!,
        ADSPRO_GROUP_JID: rawGroupJid,
        ADSPRO_GROUP_JIDS: adsproGroupJids,
        ALLOW_ALL_GROUPS: allowAllGroups,
        ALLOW_ALL_DIRECT: allowAllDirect,
        AUTHORIZED_SENDERS: authorizedSenders,
        BUCKET_RETENTION_DAYS: parseInt(process.env.BUCKET_RETENTION_DAYS || '14', 10),
        ENABLE_BUCKET_CLEANUP_CRON: process.env.ENABLE_BUCKET_CLEANUP_CRON !== 'false',
        MAX_PDF_DOWNLOAD_MB: parseInt(process.env.MAX_PDF_DOWNLOAD_MB || '150', 10)
    };
}

export const env = validateEnv();