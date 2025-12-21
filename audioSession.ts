import { getAI, LiveSession, VertexAIBackend } from "firebase/ai";
import { app } from "./firebaseAuth";
import { createAudioPlayer } from 'expo-audio';
import { setupAudioSession } from "./audioShared";

// Parallel web implementation in audio.ts
const ai = getAI(app, { backend: new VertexAIBackend("us-central1") })

export async function startAudioSession(
    onTranscriptPart: (type: 'user' | 'gemini', message: string) => void,
    onTranscriptFlush: (type: 'user' | 'gemini' | 'ended', message: string) => void,
    onServerMessage: (message: any) => void,
    systemInstruction: string
): Promise<LiveSession> {
    return setupAudioSession(ai, {
        onUserPart: (text) => onTranscriptPart('user', text),
        onModelPart: (text) => onTranscriptPart('gemini', text),
        onUserFlush: (text) => onTranscriptFlush('user', text),
        onModelFlush: (text) => onTranscriptFlush('gemini', text),
        onEnded: () => onTranscriptFlush('ended', ''),
        onUnknownMessage: (msg) => onServerMessage(msg),
        onAudioData: (base64) => {
            onServerMessage(base64);
            try {
                const player = createAudioPlayer({ uri: `data:audio/wav;base64,${base64}` });
                console.log("playing audio data")
                player.play();
            } catch (error) {
                console.error("Failed to play audio from blob URL:", error);
            }
        }
    }, systemInstruction);
}
