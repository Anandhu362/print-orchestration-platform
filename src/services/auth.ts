import { WASocket } from '@whiskeysockets/baileys';
import { firestore } from '../database/firebase';
import { env } from '../config/environment';

// ============================================================================
// IN-MEMORY DYNAMIC GROUP & PARTICIPANT CACHES
// ============================================================================
export const DESIGNATED_ADMIN_NUMBER = '918921156958';
const dynamicAuthorizedGroups = new Set<string>(env.ADSPRO_GROUP_JIDS);
const groupTitleCache = new Map<string, string>();

export function getGroupTitle(jid: string): string | undefined {
    return groupTitleCache.get(jid);
}

export function setGroupTitle(jid: string, title: string): void {
    if (jid && title) groupTitleCache.set(jid, title);
}

interface GroupMemberCache {
    members: Set<string>;
    lastUpdated: number;
}

const groupParticipantCache = new Map<string, GroupMemberCache>();
const PARTICIPANT_CACHE_TTL_MS = 5 * 60 * 1000; // 5-minute cache to avoid hammering Baileys

/**
 * Strips domain, device markers, and non-digits to get a normalized ID/number.
 */
export function normalizeUserId(rawId: string): string {
    if (!rawId) return '';
    let cleaned = rawId;
    if (cleaned.includes(':')) cleaned = cleaned.split(':')[0];
    if (cleaned.includes('@')) cleaned = cleaned.split('@')[0];
    return cleaned.replace(/[^0-9]/g, '').trim();
}

/**
 * Checks if a sender is an authorized administrator (PRIMARY_ADMIN_NUMBER, +91 8921156958, or AUTHORIZED_SENDERS).
 */
export function isPrimaryAdmin(rawId: string): boolean {
    const cleanSender = normalizeUserId(rawId);
    const cleanAdmin = normalizeUserId(env.PRIMARY_ADMIN_NUMBER);
    const designatedAdmin = normalizeUserId(DESIGNATED_ADMIN_NUMBER);
    return Boolean(
        cleanSender && (
            cleanSender === cleanAdmin ||
            cleanSender === designatedAdmin ||
            env.AUTHORIZED_SENDERS?.includes(cleanSender)
        )
    );
}

/**
 * Dynamically authorizes a group JID and persists it to Firestore so authorizations survive container restarts.
 */
export async function registerAuthorizedGroup(groupJid: string, groupName?: string): Promise<void> {
    if (!groupJid) return;
    dynamicAuthorizedGroups.add(groupJid);
    if (groupName) groupTitleCache.set(groupJid, groupName);

    try {
        await firestore.collection('authorized_groups').doc(groupJid).set({
            jid: groupJid,
            name: groupName || groupTitleCache.get(groupJid) || 'WhatsApp Group',
            authorizedAt: Date.now(),
            active: true
        }, { merge: true });
        console.log(`[INFO] [AUTH] Persisted authorized group "${groupName || groupJid}" (${groupJid})`);
    } catch (err: any) {
        console.warn('[WARN] [AUTH] Could not persist group to Firestore:', err.message);
    }
}

/**
 * Retrieves all currently authorized group JIDs.
 */
export function getAuthorizedGroups(): string[] {
    return Array.from(dynamicAuthorizedGroups);
}

/**
 * Discovers and logs all groups the bot participates in, auto-whitelists groups by name
 * (e.g. COLORZONE, APPROVED FILES, ADSPRO), and hydrates approved groups from Firestore.
 */
export async function syncParticipatingGroups(sock: WASocket): Promise<string[]> {
    try {
        // 1. Hydrate previously authorized groups from Firestore
        try {
            const snapshot = await firestore.collection('authorized_groups').where('active', '==', true).get();
            for (const doc of snapshot.docs) {
                const data = doc.data();
                if (data.jid) {
                    dynamicAuthorizedGroups.add(data.jid);
                    if (data.name) groupTitleCache.set(data.jid, data.name);
                }
            }
            if (!snapshot.empty) {
                console.log(`[INFO] [AUTH] Hydrated ${snapshot.size} authorized group(s) from Firestore.`);
            }
        } catch (fsErr: any) {
            console.warn('[WARN] [AUTH] Could not hydrate groups from Firestore:', fsErr.message);
        }

        // 2. Fetch all participating groups from Baileys
        const participating = await sock.groupFetchAllParticipating();
        const groups = Object.values(participating);
        console.log(`\n[INFO] [AUTH] WhatsApp Groups Inventory (${groups.length} group(s)):`);

        for (const g of groups) {
            groupTitleCache.set(g.id, g.subject);
            const isNameMatched = /approved\s*files|colorzone|adspro/i.test(g.subject);
            if (isNameMatched) {
                dynamicAuthorizedGroups.add(g.id);
                // Persist to Firestore asynchronously
                registerAuthorizedGroup(g.id, g.subject).catch(() => {});
                console.log(`   [AUTO-AUTHORIZED] "${g.subject}" -> JID: ${g.id}`);
            } else {
                const isWhitelisted = dynamicAuthorizedGroups.has(g.id);
                console.log(`   [${isWhitelisted ? 'AUTHORIZED' : 'UNREGISTERED'}] "${g.subject}" -> JID: ${g.id}`);
            }
        }

        return Array.from(dynamicAuthorizedGroups);
    } catch (err: any) {
        console.warn('[WARN] [AUTH] Group inventory sync error:', err.message);
        return Array.from(dynamicAuthorizedGroups);
    }
}

/**
 * Fetches and caches participants across authorized groups to enable auto-inheritance.
 */
async function isUserInAuthorizedGroups(cleanLid: string, sock?: WASocket): Promise<boolean> {
    if (!sock) return false;

    try {
        // Collect target groups: configured groups + dynamically registered groups
        let targetGroups = getAuthorizedGroups();

        // If ALLOW_ALL_GROUPS is enabled or targetGroups is empty, fetch all participating groups from Baileys
        if (targetGroups.length === 0 || env.ALLOW_ALL_GROUPS) {
            try {
                const participating = await sock.groupFetchAllParticipating();
                const fetchedJids = Object.keys(participating);
                for (const jid of fetchedJids) {
                    dynamicAuthorizedGroups.add(jid);
                }
                targetGroups = Array.from(dynamicAuthorizedGroups);
            } catch (err: any) {
                console.warn('[AUTH] Could not fetch participating groups for auto-inheritance:', err?.message);
            }
        }

        const now = Date.now();

        for (const groupJid of targetGroups) {
            let cached = groupParticipantCache.get(groupJid);

            // Refresh participant cache if missing or expired
            if (!cached || (now - cached.lastUpdated) > PARTICIPANT_CACHE_TTL_MS) {
                try {
                    const metadata = await sock.groupMetadata(groupJid);
                    const memberSet = new Set<string>();
                    for (const participant of metadata.participants || []) {
                        const cleanP = normalizeUserId(participant.id);
                        if (cleanP) memberSet.add(cleanP);
                    }
                    cached = { members: memberSet, lastUpdated: now };
                    groupParticipantCache.set(groupJid, cached);
                } catch {
                    // Group may have been deleted or bot removed, skip
                    continue;
                }
            }

            if (cached.members.has(cleanLid)) {
                return true;
            }
        }
    } catch (err: any) {
        console.warn('[AUTH] Group participant auto-inheritance error:', err?.message);
    }

    return false;
}

/**
 * Registers a user directly into Firestore (e.g. via WhatsApp in-chat .auth command).
 */
export async function authorizeUserInFirestore(cleanLid: string, label: string = 'WhatsApp Authorized User'): Promise<boolean> {
    try {
        const normalized = normalizeUserId(cleanLid);
        if (!normalized) return false;

        await firestore.collection('authorized_users').doc(normalized).set({
            active: true,
            label,
            updatedAt: new Date().toISOString()
        }, { merge: true });

        console.log(`[INFO] [AUTH] Registered user ${normalized} in Firestore.`);
        return true;
    } catch (err: any) {
        console.error('[AUTH] Failed to save user to Firestore:', err?.message);
        return false;
    }
}

/**
 * Multi-layer zero-ID authorization gate:
 * 1. Open direct chat mode (ALLOW_ALL_DIRECT=true)
 * 2. Primary admin number check
 * 3. AUTHORIZED_SENDERS array from .env
 * 4. Firestore authorized_users collection
 * 5. Group Member Auto-Inheritance (member of any authorized group)
 */
export async function isAuthorizedUser(cleanLid: string, sock?: WASocket): Promise<boolean> {
    const normalized = normalizeUserId(cleanLid);
    if (!normalized) return false;

    // 1. Open direct chat policy
    if (env.ALLOW_ALL_DIRECT) {
        return true;
    }

    // 2. Primary admin check
    if (isPrimaryAdmin(normalized)) {
        return true;
    }

    // 3. Check AUTHORIZED_SENDERS in .env
    if (env.AUTHORIZED_SENDERS.includes(normalized)) {
        return true;
    }

    // 4. Check Firestore database
    try {
        const docRef = firestore.collection('authorized_users').doc(normalized);
        const snapshot = await docRef.get();

        if (snapshot.exists) {
            const data = snapshot.data();
            if (data?.active !== false) {
                return true;
            }
        }
    } catch (error) {
        console.error('[AuthService] DB Error checking LID in Firestore:', error);
    }

    // 5. Group Member Auto-Inheritance
    if (sock) {
        const isInGroup = await isUserInAuthorizedGroups(normalized, sock);
        if (isInGroup) {
            console.log(`[INFO] [AUTH] Auto-authorized group member: ${normalized} (inherited from print group)`);
            // Cache in Firestore non-blockingly so future lookups are instant
            authorizeUserInFirestore(normalized, 'Auto-Inherited Group Member').catch(() => {});
            return true;
        }
    }

    return false;
}