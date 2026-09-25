import makeWASocket, { 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    Browsers, 
    WASocket 
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import { useFirebaseAuthState } from './session';
import { handleIncomingMessage } from '../services/router';
import { adsproBuffer } from '../services/adsproBuffer';
import { syncParticipatingGroups } from '../services/auth';

// ============================================================================
// SUPPRESS VERBOSE LIBSIGNAL CRYPTOGRAPHIC SESSION DUMPS
// ============================================================================
const originalConsoleInfo = console.info;
console.info = (...args: any[]) => {
    if (typeof args[0] === 'string' && (
        args[0].startsWith('Closing session:') ||
        args[0].startsWith('Opening session:') ||
        args[0].startsWith('Removing old closed session:') ||
        args[0].startsWith('Migrating session to:')
    )) {
        return; // Suppress verbose internal E2EE session dumps
    }
    originalConsoleInfo(...args);
};

const originalConsoleWarn = console.warn;
console.warn = (...args: any[]) => {
    if (typeof args[0] === 'string' && (
        args[0].includes('Closing stale open session') ||
        args[0].includes('Closing open session in favor of incoming') ||
        args[0].includes('Session already closed') ||
        args[0].includes('Session already open') ||
        args[0].includes('Decrypted message with closed session')
    )) {
        return; // Suppress internal Signal session state warnings
    }
    originalConsoleWarn(...args);
};

// ============================================================================
// SINGLETON CONNECTION STATE & RECONNECT CONTROLLER
// ============================================================================
let currentSock: WASocket | null = null;
let isConnecting = false;
let reconnectTimeout: NodeJS.Timeout | null = null;
let reconnectAttempts = 0;
let presenceHeartbeatInterval: NodeJS.Timeout | null = null;

/**
 * Returns formatted ISO timestamp and Dubai GST local time for auditing.
 * Example: [2026-09-22T12:48:51.123Z | 16:48:51 GST]
 */
function getLogTime(): string {
    const now = new Date();
    const iso = now.toISOString();
    const gstTime = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Dubai', hour12: false });
    return `[${iso} | ${gstTime} GST]`;
}

/**
 * Cleanly terminates and destroys any existing socket and its event listeners.
 * Prevents recursive ghost socket cascades and memory leaks inside Node.js.
 */
function teardownExistingSocket(): void {
    if (presenceHeartbeatInterval) {
        clearInterval(presenceHeartbeatInterval);
        presenceHeartbeatInterval = null;
    }

    if (currentSock) {
        try {
            console.log(`${getLogTime()} [INFO] [SOCKET] Tearing down previous socket instance...`);
            currentSock.ev.removeAllListeners('connection.update');
            currentSock.ev.removeAllListeners('creds.update');
            currentSock.ev.removeAllListeners('messages.upsert');
            currentSock.end(undefined);
        } catch (err: any) {
            console.warn(`${getLogTime()} [WARN] [SOCKET] Teardown notice on previous socket:`, err.message);
        }
        currentSock = null;
    }
}

/**
 * Schedules an orderly reconnection with exponential backoff and jitter.
 * Prevents zero-delay reconnect storms that trigger WhatsApp edge rate-limiting (428).
 */
function scheduleReconnect(customDelayMs?: number): void {
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }

    reconnectAttempts++;
    
    // Backoff formula: 5s, 7.5s, 11.2s, 16.8s... capped at 60s max
    const baseDelay = customDelayMs ?? Math.min(60000, 5000 * Math.pow(1.5, Math.min(reconnectAttempts - 1, 6)));
    // Add randomized jitter (+/- 15%) to avoid synchronized hammering
    const jitter = baseDelay * 0.15 * (Math.random() * 2 - 1);
    const delayMs = Math.max(3000, Math.round(baseDelay + jitter));

    console.log(`${getLogTime()} [INFO] [RECONNECT] Next reconnection in ${(delayMs / 1000).toFixed(1)}s (Attempt #${reconnectAttempts})...`);

    reconnectTimeout = setTimeout(() => {
        reconnectTimeout = null;
        connectToWhatsApp().catch(err => {
            console.error(`${getLogTime()} [ERROR] [RECONNECT] Scheduled reconnect failure:`, err.message);
            scheduleReconnect();
        });
    }, delayMs);
    reconnectTimeout.unref?.();
}

/**
 * Bootstraps and manages the primary Baileys WhatsApp WebSocket connection.
 */
export async function connectToWhatsApp(): Promise<WASocket | null> {
    if (isConnecting) {
        console.warn(`${getLogTime()} [WARN] [SOCKET] Connection handshake already in progress. Skipping duplicate call.`);
        return currentSock;
    }

    isConnecting = true;

    try {
        // 0. Cleanly teardown any prior socket to guarantee exactly 1 active socket per process
        teardownExistingSocket();

        // 1. Hydrate authentication state from Firebase RTDB
        const { state, saveCreds } = await useFirebaseAuthState();
        
        let version: [number, number, number];
        let isLatest = false;
        try {
            const versionInfo = await fetchLatestBaileysVersion();
            version = versionInfo.version;
            isLatest = versionInfo.isLatest;
        } catch (verErr: any) {
            console.warn(`${getLogTime()} [WARN] [WHATSAPP] Failed to fetch latest web version, falling back to bundled:`, verErr.message);
            version = [2, 3000, 1015901307];
        }

        console.log(`${getLogTime()} [INFO] [WHATSAPP] Engine initializing (v${version.join('.')}, isLatest: ${isLatest})`);

        // 2. Initialize the Baileys Socket with Production-Grade Network Tuning
        const sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }) as any,
            printQRInTerminal: true,
            auth: state,
            markOnlineOnConnect: true,
            
            // Standard recognized Ubuntu Chrome browser signature
            browser: Browsers.ubuntu('Chrome'),
            
            // Network & Keep-Alive Hardening for Cloud VM / Docker NAT
            keepAliveIntervalMs: 30000,     // Ping WhatsApp servers every 30s to prevent silent VPC NAT drops
            connectTimeoutMs: 60000,        // 60s timeout for TCP/TLS handshake
            defaultQueryTimeoutMs: 120000,  // 120s timeout for heavy database / media queries
            syncFullHistory: false,         // Skip heavy historical message sync
            
            // Performance Optimizations
            generateHighQualityLinkPreview: false,
            
            getMessage: async () => {
                return {
                    conversation: 'Vecta Assistant Message'
                };
            }
        });

        currentSock = sock;

        // 3. Register Event Listeners
        sock.ev.process(async (events) => {
            // --- CONNECTION STATE HANDLING ---
            if (events['connection.update']) {
                const update = events['connection.update'];
                const { connection, lastDisconnect } = update;

                if (connection === 'close') {
                    const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
                    const isLoggedOut = statusCode === DisconnectReason.loggedOut;
                    
                    console.warn(`${getLogTime()} [WARN] [SOCKET] Connection closed (Code: ${statusCode || 'unknown'}, Reason: ${lastDisconnect?.error?.message || 'Disconnected'})`);

                    if (isLoggedOut) {
                        console.error(`${getLogTime()} [FATAL] [AUTH] WhatsApp session logged out or revoked. Re-scan required.`);
                        teardownExistingSocket();
                        return;
                    }

                    // Specific handling: stream:error code 503 (WhatsApp Gateway / Server Overloaded)
                    if (statusCode === 503) {
                        console.warn(`${getLogTime()} [WARN] [GATEWAY] Edge gateway stream error (503). Backing off 10s...`);
                        scheduleReconnect(10000);
                        return;
                    }

                    // Specific handling: connection replaced (440)
                    if (statusCode === DisconnectReason.connectionReplaced) {
                        console.warn(`${getLogTime()} [WARN] [SOCKET] Conflict: session replaced by another client. Backing off 15s...`);
                        scheduleReconnect(15000);
                        return;
                    }

                    // Specific handling: restart required (515)
                    if (statusCode === DisconnectReason.restartRequired) {
                        console.log(`${getLogTime()} [INFO] [SOCKET] Restart required by WhatsApp. Reconnecting in 3s...`);
                        scheduleReconnect(3000);
                        return;
                    }

                    // Default backoff reconnection (5s, 7.5s, 11s...)
                    scheduleReconnect();

                } else if (connection === 'open') {
                    console.log(`${getLogTime()} [INFO] [WHATSAPP] Client connection established and listening for events`);
                    reconnectAttempts = 0; // Reset reconnection counter on stable connection
                    
                    if (reconnectTimeout) {
                        clearTimeout(reconnectTimeout);
                        reconnectTimeout = null;
                    }

                    // Active Keep-Alive Heartbeat: Send presence update every 5 minutes to prevent Cloud NAT idle timeouts
                    if (presenceHeartbeatInterval) {
                        clearInterval(presenceHeartbeatInterval);
                    }
                    presenceHeartbeatInterval = setInterval(async () => {
                        try {
                            if (currentSock?.ws?.isOpen) {
                                await currentSock.sendPresenceUpdate('available');
                            }
                        } catch (err) {
                            // Silent catch for transient presence ping failures
                        }
                    }, 5 * 60 * 1000);
                    presenceHeartbeatInterval.unref?.();

                    // Hand the active socket to the ADSPRO Print Automation buffer for 1-on-1 receipts
                    adsproBuffer.setSocket(sock);

                    // Discover participating groups, log inventory, and auto-authorize matches
                    syncParticipatingGroups(sock).catch((err) => {
                        console.warn(`${getLogTime()} [WARN] [WHATSAPP] Failed to sync participating groups:`, err.message);
                    });
                }
            }

            // --- CREDENTIAL SYNCING ---
            if (events['creds.update']) {
                await saveCreds();
            }

            // --- MESSAGE INTERCEPTION WITH ZERO-DROP OFFLINE RECONNECT CATCH-UP ---
            if (events['messages.upsert']) {
                const upsert = events['messages.upsert'];
                const now = Date.now();
                const MAX_CATCHUP_AGE_MS = 15 * 60 * 1000; // 15-minute catch-up window

                for (const msg of upsert.messages) {
                    if (!msg.message || msg.key.fromMe) continue;

                    // Calculate message age from WhatsApp server timestamp
                    const msgTimestamp = typeof msg.messageTimestamp === 'number' 
                        ? msg.messageTimestamp 
                        : Number(msg.messageTimestamp) || 0;
                    const msgTimeMs = msgTimestamp * 1000;
                    const ageMs = now - msgTimeMs;

                    // Guarantee: Process both real-time ('notify') and backlog ('append') messages
                    // Skip ancient historical messages (>15m), but NEVER skip messages sent during reconnect!
                    if (msgTimeMs > 0 && ageMs > MAX_CATCHUP_AGE_MS) {
                        continue;
                    }

                    if (upsert.type === 'append') {
                        console.log(`${getLogTime()} [INFO] [QUEUE] Offline catch-up message received during reconnect window (Age: ${(ageMs / 1000).toFixed(1)}s, ID: ${msg.key.id})`);
                    }

                    await handleIncomingMessage(sock, msg);
                }
            }
        });

        return sock;

    } catch (bootErr: any) {
        console.error('[FATAL] [SOCKET] Fatal error during WhatsApp client initialization:', bootErr.message);
        scheduleReconnect(10000);
        return null;
    } finally {
        isConnecting = false;
    }
}

/**
 * Cleanly shuts down the WhatsApp socket.
 */
export function disconnectWhatsApp(): void {
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }
    if (presenceHeartbeatInterval) {
        clearInterval(presenceHeartbeatInterval);
        presenceHeartbeatInterval = null;
    }
    teardownExistingSocket();
    console.log(`${getLogTime()} [INFO] [SOCKET] WhatsApp client cleanly stopped.`);
}