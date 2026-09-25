import { AuthenticationState, AuthenticationCreds, initAuthCreds } from '@whiskeysockets/baileys';
import { db } from '../database/firebase';
import { env } from '../config/environment';

const sanitizeId = (id: string) => id.replace(/\./g, '___dot___');

const BufferJSON = {
    replacer: (k: any, value: any) => {
        if (Buffer.isBuffer(value) || value instanceof Uint8Array || value?.type === 'Buffer') {
            return { type: 'Buffer', data: Buffer.from(value?.data || value).toString('base64') };
        }
        return value;
    },
    reviver: (_: any, value: any) => {
        if (typeof value === 'object' && !!value && value.type === 'Buffer') {
            return Buffer.from(value.data, 'base64');
        }
        return value;
    }
};

export async function useFirebaseAuthState(): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
    const sessionRef = db.ref(`whatsapp_sessions/${env.WA_SESSION_ID}`);
    
    const snapshot = await sessionRef.child('creds').once('value');
    const existingCreds = snapshot.val();

    // Parse the stringified creds if they exist, safely handling if it's already an object
    let creds: AuthenticationCreds;
    if (existingCreds) {
        if (typeof existingCreds === 'string') {
            creds = JSON.parse(existingCreds, BufferJSON.reviver);
        } else {
            creds = existingCreds; // It's already an object, use it directly
        }
    } else {
        creds = initAuthCreds();
    }

    const keys = {
        get: async (type: string, ids: string[]) => {
            const data: { [id: string]: any } = {};
            for (const id of ids) {
                const safeId = sanitizeId(id);
                const keySnapshot = await sessionRef.child(`keys/${type}/${safeId}`).once('value');
                let value = keySnapshot.val();
                
                if (value) {
                    // Re-hydrate the data safely
                    if (typeof value === 'string') {
                        value = JSON.parse(value, BufferJSON.reviver);
                    } else if (typeof value === 'object') {
                        value = JSON.parse(JSON.stringify(value), BufferJSON.reviver);
                    }
                    data[id] = value;
                }
            }
            return data;
        },
        set: async (data: any) => {
            const tasks: Promise<void>[] = [];
            for (const category in data) {
                for (const id in data[category]) {
                    const safeId = sanitizeId(id);
                    const value = data[category][id];
                    const nodeRef = sessionRef.child(`keys/${category}/${safeId}`);
                    
                    if (value) {
                        tasks.push(nodeRef.set(JSON.stringify(value, BufferJSON.replacer)));
                    } else {
                        tasks.push(nodeRef.remove());
                    }
                }
            }
            await Promise.all(tasks);
        }
    };

    return {
        state: {
            creds,
            keys: keys as any
        },
        saveCreds: async () => {
            await sessionRef.child('creds').set(JSON.stringify(creds, BufferJSON.replacer));
        }
    };
}