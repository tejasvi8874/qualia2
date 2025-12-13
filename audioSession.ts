import { getLiveGenerativeModel, LiveSession, startAudioConversation } from "firebase/ai";
import { ai } from "./firebaseAuth";
import { createAudioPlayer } from 'expo-audio';
import { Buffer } from 'buffer';

// Parallel web implementation in audio.html

import { AUDIO_GENERATION_CONFIG, processStreamMessages } from "./audioShared";

// Parallel web implementation in audio.html

export async function startAudioSession(onTranscriptPart: (type: 'user' | 'gemini', message: string) => void, onTranscriptFlush: (type: 'user' | 'gemini' | 'ended', message: string) => void, systemInstruction?: string): Promise<LiveSession> {
    const model = getLiveGenerativeModel(ai, {
        ...AUDIO_GENERATION_CONFIG,
        systemInstruction: systemInstruction,
    });

    const session = await model.connect();
    await startAudioConversation(session);
    receiveMessages(session, onTranscriptPart, onTranscriptFlush);
    return session;
}

async function receiveMessages(liveSession: LiveSession, onTranscriptPart: (type: 'user' | 'gemini', message: string) => void, onTranscriptFlush: (type: 'user' | 'gemini' | 'ended', message: string) => void) {
    await processStreamMessages(liveSession, {
        onUserPart: (text) => onTranscriptPart('user', text),
        onModelPart: (text) => onTranscriptPart('gemini', text),
        onUserFlush: (text) => onTranscriptFlush('user', text),
        onModelFlush: (text) => onTranscriptFlush('gemini', text),
        onEnded: () => onTranscriptFlush('ended', ''),
        onAudioData: (base64) => {
            try {
                const player = createAudioPlayer({ uri: `data:audio/wav;base64,${base64}` });
                player.play();
            } catch (error) {
                console.error("Failed to play audio from blob URL:", error);
            }
        }
    });
}
