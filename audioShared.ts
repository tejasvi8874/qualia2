import { LiveSession } from "firebase/ai";

export const AUDIO_GENERATION_CONFIG = {
    model: "gemini-live-2.5-flash-preview",
    generationConfig: {
        inputAudioTranscription: { model: "google-speech-to-text-english-pitch-v2" },
        outputAudioTranscription: { model: "google-speech-to-text-english-pitch-v2" },
        responseModalities: "AUDIO" as any,
        speechConfig: {
            voiceConfig: {
                prebuiltVoiceConfig: {
                    voiceName: "Aoede",
                },
            },
        },
    },
};

export interface AudioCallbacks {
    onUserPart: (text: string) => void;
    onModelPart: (text: string) => void;
    onUserFlush: (text: string) => void;
    onModelFlush: (text: string) => void;
    onEnded: () => void;
    onAudioData?: (base64: string) => void;
}

export async function processStreamMessages(
    session: LiveSession,
    callbacks: AudioCallbacks
) {
    const messageStream = session.receive();
    const userTranscription: string[] = [];
    const modelTranscription: string[] = [];
    let userFlushTimeout: any = null;
    let modelFlushTimeout: any = null;

    const flushUser = () => {
        if (userFlushTimeout) clearTimeout(userFlushTimeout);
        userFlushTimeout = null;
        if (userTranscription.length > 0) {
            callbacks.onUserFlush(userTranscription.join(""));
            userTranscription.length = 0;
        }
    };
    const flushModel = () => {
        if (modelFlushTimeout) clearTimeout(modelFlushTimeout);
        modelFlushTimeout = null;
        if (modelTranscription.length > 0) {
            callbacks.onModelFlush(modelTranscription.join(""));
            modelTranscription.length = 0;
        }
    };

    try {
        for await (const message of messageStream) {
            if (message.type === "serverContent") {
                if (message.inputTranscription?.text) {
                    flushModel();
                    const text = message.inputTranscription.text;
                    callbacks.onUserPart(text);
                    userTranscription.push(text);
                    if (userFlushTimeout) clearTimeout(userFlushTimeout);
                    userFlushTimeout = setTimeout(flushUser, 1000);
                }
                if (message.outputTranscription?.text) {
                    flushUser();
                    const text = message.outputTranscription.text;
                    callbacks.onModelPart(text);
                    modelTranscription.push(text);
                    if (modelFlushTimeout) clearTimeout(modelFlushTimeout);
                    modelFlushTimeout = setTimeout(flushModel, 1000);
                }

                if (callbacks.onAudioData) {
                    for (const part of message.modelTurn?.parts || []) {
                        if (part.inlineData?.data) {
                            callbacks.onAudioData(part.inlineData.data);
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
        callbacks.onEnded();
    }
}
