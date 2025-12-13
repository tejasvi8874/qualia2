import { LiveSession } from "firebase/ai";
import { ai } from "./firebaseAuth";
import { createAudioPlayer } from 'expo-audio';

// Parallel web implementation in audio.html

import { setupAudioSession } from "./audioShared";

// Parallel web implementation in audio.html

export async function startAudioSession(onTranscriptPart: (type: 'user' | 'gemini', message: string) => void, onTranscriptFlush: (type: 'user' | 'gemini' | 'ended', message: string) => void, systemInstruction?: string): Promise<LiveSession> {
    return setupAudioSession(ai, {
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
    }, systemInstruction);
}
