import { getLiveGenerativeModel, LiveSession, startAudioConversation } from "firebase/ai";
import { ai } from "./firebaseAuth";
import { createAudioPlayer } from 'expo-audio';
import { Buffer } from 'buffer';

// Parallel web implementation in audio.html

export async function startAudioSession(onTranscriptPart: (type: 'user' | 'gemini', message: string) => void, onTranscriptFlush: (type: 'user' | 'gemini' | 'ended', message: string) => void): Promise<LiveSession> {
    const model = getLiveGenerativeModel(ai, {
        model: "gemini-live-2.5-flash-preview",
        generationConfig: {
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            responseModalities: ["AUDIO"],
            speechConfig: {
                voiceConfig: {
                    prebuiltVoiceConfig: {
                        voiceName: "Aoede"
                    }
                }
            },
        }
    });

    const session = await model.connect();
    await startAudioConversation(session);
    receiveMessages(session, onTranscriptPart, onTranscriptFlush);
    return session;
}

async function receiveMessages(liveSession: LiveSession, onTranscriptPart: (type: 'user' | 'gemini', message: string) => void, onTranscriptFlush: (type: 'user' | 'gemini' | 'ended', message: string) => void) {
    const messageStream = liveSession.receive();
    const userTranscription: string[] = [];
    const modelTranscription: string[] = [];
    let userFlushTimeout: ReturnType<typeof setTimeout> | null = null;
    let modelFlushTimeout: ReturnType<typeof setTimeout> | null = null;

    const flushUser = () => {
        if (userFlushTimeout) clearTimeout(userFlushTimeout);
        userFlushTimeout = null;
        if (userTranscription.length > 0) {
            onTranscriptFlush('user', userTranscription.join(""));
            userTranscription.length = 0;
        }
    };
    const flushModel = () => {
        if (modelFlushTimeout) clearTimeout(modelFlushTimeout);
        modelFlushTimeout = null;
        if (modelTranscription.length > 0) {
            onTranscriptFlush('gemini', modelTranscription.join(""));
            modelTranscription.length = 0;
        }
    };

    try {
        for await (const message of messageStream) {
            console.log(JSON.parse(JSON.stringify(message)));
            if (message.type === 'serverContent') {
                if (message.inputTranscription?.text) {
                    flushModel();
                    const text = message.inputTranscription.text;
                    onTranscriptPart('user', text);
                    userTranscription.push(text);
                    if (userFlushTimeout) clearTimeout(userFlushTimeout);
                    userFlushTimeout = setTimeout(flushUser, 1000);
                }
                if (message.outputTranscription?.text) {
                    flushUser();
                    const text = message.outputTranscription.text;
                    onTranscriptPart('gemini', text);
                    modelTranscription.push(text);
                    if (modelFlushTimeout) clearTimeout(modelFlushTimeout);
                    modelFlushTimeout = setTimeout(flushModel, 1000);
                }
                for (const part of message.modelTurn?.parts || []) {
                    if (part.inlineData) {
                        const base64AudioData = part.inlineData.data;
                        const mimeType = part.inlineData.mimeType; // E.g. "audio/pcm;rate=24000"
                        try {
                            const player = createAudioPlayer({ uri: `data:audio/wav;base64,${base64AudioData}` });
                            player.play();
                        } catch (error) {
                            console.error("Failed to play audio from blob URL:", error);
                        }
                    }
                }

                if (message.turnComplete) {
                    flushUser();
                    flushModel();
                }
            }
        }
    } finally {
        flushUser();
        flushModel();
        onTranscriptFlush('ended', '');
    }
}
