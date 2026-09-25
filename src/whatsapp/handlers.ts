import { delay } from '@whiskeysockets/baileys';

// ============================================================================
// STATE: In-Memory Delay Tracker
// ============================================================================
// We store the last 3 calculated delays here. By checking against this array,
// we ensure the bot doesn't accidentally pick the exact same typing duration 
// twice in a row, which breaks the human illusion.
const recentDelays: number[] = [];

/**
 * Generates a randomized, variable human-like delay between 5.5 and 8.5 seconds.
 * Avoids repeating closely resembling intervals within a 3-turn history window.
 */
function calculateHumanDelay(): number {
    let chosenDelay = 0;
    let attempts = 0;

    // We use a while loop to try finding a unique delay up to 10 times.
    // If it fails 10 times (highly unlikely), it just uses the last generated one.
    while (attempts < 10) {
        // Generate a random value between 5500ms and 8500ms
        chosenDelay = Math.floor(Math.random() * 3000) + 5500;
        
        // Ensure this delay is distinct (+/- 400ms variance) from the last 3 values
        const tooClose = recentDelays.some(prev => Math.abs(prev - chosenDelay) < 400);
        
        if (!tooClose) break; // We found a good, unique delay!
        
        attempts++;
    }

    // Add the new delay to our history
    recentDelays.push(chosenDelay);
    
    // Keep the array size at exactly 3 to prevent memory leaks over months of uptime
    if (recentDelays.length > 3) {
        recentDelays.shift(); 
    }

    return chosenDelay;
}

// ============================================================================
// CORE HANDLER: The Human Mimic Engine
// ============================================================================

/**
 * Handles the visual choreography sequence: 
 * Blue Ticks -> Thinking -> Multi-stage Typing -> Send
 */
export async function sendWithHumanMimic(sock: any, jid: string, messageKey: any, replyText: string) {
    try {
        // 1. Instantly trigger read receipts (blue ticks)
        // This tells the sender the bot has "seen" the message.
        await sock.readMessages([messageKey]);

        // 2. Initial Pause
        // Mimic the time it takes a human to actually read the incoming text.
        await delay(1200);

        // 3. Initiate "typing..." status indicator
        await sock.sendPresenceUpdate('composing', jid);

        const totalTypingTime = calculateHumanDelay();
        
        // 4. Split the typing into two stages
        // Humans rarely type for 8 seconds straight without pausing to think.
        // We split the delay 45% / 55% to create a natural rhythm.
        const firstLeg = Math.floor(totalTypingTime * 0.45);
        const secondLeg = totalTypingTime - firstLeg;

        // Type the first half...
        await delay(firstLeg);
        
        // Simulates looking away or thinking of the right word
        await sock.sendPresenceUpdate('paused', jid); 
        await delay(700); 
        
        // Resumes active typing for the remainder of the time
        await sock.sendPresenceUpdate('composing', jid); 
        await delay(secondLeg);

        // 5. Clean Drop
        // Drop the presence indicator securely right before firing. 
        // This prevents the "typing..." indicator from hanging if the network lags.
        await sock.sendPresenceUpdate('paused', jid);

        // 6. Fire Payload
        // Actually deliver the AI's generated response down the socket stream.
        await sock.sendMessage(jid, { text: replyText });
        
    } catch (error) {
        console.error(`[MIMIC ENGINE ERROR] Failed to send to ${jid}:`, error);
        // If the mimic engine fails, we throw the error up to the orchestrator 
        // so it can mark the message as 'failed' in Firestore for a later retry.
        throw error; 
    }
}