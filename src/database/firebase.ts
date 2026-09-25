import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { getFirestore } from 'firebase-admin/firestore'; 
import { getStorage } from 'firebase-admin/storage';
import { env } from '../config/environment';

export const CLOUD_STORAGE_BUCKET_NAME = process.env.FIREBASE_STORAGE_BUCKET || 'run-sources-whatsapp-assistant-sa-me-central1';

// Initialize Firebase Admin cleanly if it hasn't been initialized already
if (!getApps().length) {
    // Initialize Default App (Local Bot DB)
    initializeApp({
        databaseURL: env.FIREBASE_DATABASE_URL,
        storageBucket: CLOUD_STORAGE_BUCKET_NAME,
        credential: cert(env.GCP_SERVICE_ACCOUNT_KEY as any) 
    });
}

// Export Realtime Database for Baileys session management
export const db = getDatabase();

// Export Local Firestore for the high-speed reminder engine & idempotency locks
export const firestore = getFirestore();

// Export Firebase Storage & Dedicated Flyer Bucket
export const storage = getStorage();
export const flyerBucket = storage.bucket(CLOUD_STORAGE_BUCKET_NAME);

console.log('[INFO] [DATABASE] Firebase Admin SDK initialized (Firestore, RTDB, Cloud Storage).');