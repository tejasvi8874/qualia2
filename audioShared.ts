import { FunctionCallingMode, LiveModelParams, LiveSession, ResponseModality } from "firebase/ai";

export const AUDIO_GENERATION_CONFIG: LiveModelParams = {
    model: "gemini-live-2.5-flash-preview-native-audio-09-2025",
    // model: "gemini-2.5-flash-native-audio-preview-09-2025",
    // model: "gemini-live-2.5-flash-preview",
    generationConfig: {
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        responseModalities: [ResponseModality.AUDIO],
        speechConfig: {
            voiceConfig: {
                prebuiltVoiceConfig: {
                    voiceName: "Leda",
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
    onUnknownMessage?: (message: any) => void;
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
            console.log(message)
            if (message.type === "serverContent") {
                if (message.inputTranscription && (message.inputTranscription as any).finished) {
                    flushUser();
                }
                if (message.outputTranscription
                    && ((message.outputTranscription as any).finished || (message.outputTranscription as any).generationComplete)) {
                    flushModel();
                }
                if (message.inputTranscription?.text) {
                    flushModel();
                    const text = message.inputTranscription.text;
                    const textToEmit = (userTranscription.length > 0 && !text.startsWith(" ")) ? " " + text : text;
                    callbacks.onUserPart(textToEmit);
                    userTranscription.push(textToEmit);
                    if (userFlushTimeout) clearTimeout(userFlushTimeout);
                    userFlushTimeout = setTimeout(flushUser, 2000);
                }
                if (message.outputTranscription?.text) {
                    flushUser();
                    const text = message.outputTranscription.text;
                    callbacks.onModelPart(text);
                    modelTranscription.push(text);
                    if (modelFlushTimeout) clearTimeout(modelFlushTimeout);
                    modelFlushTimeout = setTimeout(flushModel, 2000);
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
            } else if (message.type === "unknown" && callbacks.onUnknownMessage) {
                callbacks.onUnknownMessage(message);
            }
        }
    } finally {
        flushUser();
        flushModel();
        callbacks.onEnded();
    }
}

import { getLiveGenerativeModel, startAudioConversation, AI } from "firebase/ai";
import { inMemoryPersistence } from "firebase/auth";

export async function connectAndStartAudioSession(
    ai: AI,
    systemInstruction: string
): Promise<LiveSession> {
    const model = getLiveGenerativeModel(ai, {
        ...AUDIO_GENERATION_CONFIG,
        systemInstruction: systemInstruction,
    });
    const setupMessage = model.createSetupMessage();
    const connectParams = {
        setup: {
            ...setupMessage.setup,
            generationConfig: {
                ...setupMessage.setup.generationConfig,
                thinkingConfig: {
                    // thinkingBudget: 1024
                },
                enableAffectiveDialog: true,
            },
            contextWindowCompression: {
                triggerTokens: 128_000,
                slidingWindow: { targetTokens: 100_000 }
            }
        }
    }
    console.log("session created", { setupMessage, connectParams })
    const session = await model.connect(connectParams);
    await startAudioConversation(session);
    return session;
}

export async function setupAudioSession(
    ai: AI,
    callbacks: AudioCallbacks,
    systemInstruction: string,
    initialMessage: string = "(Call started)"
): Promise<LiveSession> {
    const session = await connectAndStartAudioSession(ai, systemInstruction);

    if (initialMessage) {
        console.log(`intial message sent ${initialMessage}`)
        session.send({ clientContent: { turns: [{ role: 'user', parts: [{ text: initialMessage }] }], turnComplete: true } });
    }

    // Start processing messages without awaiting it to block
    processStreamMessages(session, callbacks).catch(err => {
        console.error("Error in processStreamMessages:", err);
    });

    return session;
}
