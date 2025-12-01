import { initializeApp } from "firebase/app";
import {
    Auth,
    getAuth,
    signInWithCustomToken,
} from "firebase/auth";
import {
    getAI,
    getLiveGenerativeModel,
    startAudioConversation,
    GoogleAIBackend,
    AI,
    LiveSession,
} from "firebase/ai";
import { firebaseConfig } from "./firebaseConfig";
// This script is self-contained and runs inside the native WebView.
// It receives the firebaseConfig and an ID token via injection/messages from App.tsx.

const post = (payload: any) =>
    (window as any).ReactNativeWebView.postMessage(JSON.stringify(payload));
const log = (message: any) => post({ type: "log", message });

// Early readiness ping so the host knows we loaded, even if init fails.
post({ type: "ready" });
log("HAHAHAH");
let auth: Auth;
let ai: AI;

let app = initializeApp(firebaseConfig);
console.log("app init")
const back = new GoogleAIBackend();
console.log("back init")
try {
    auth = getAuth(app);
    ai = getAI(app);
    log("Audio WebView initialized");
} catch (err: any) {
    log("Audio WebView init failed: " + JSON.stringify(err.stack));
    post({
        type: "authError",
        message: JSON.stringify(err.stack),
    });
}

async function ensureSignedIn(idToken: string) {
    if (!idToken) {
        post({ type: "authError", message: "Missing idToken" });
        return;
    }
    log("Before current user");
    log(JSON.stringify(getAuth));
    log("after stringify")
    if (auth.currentUser) {
        log("Already signed in");
        return;
    }
    log("before try")
    try {
        // Best-effort: reuse provided token. If it is not a custom token, this may fail; we still proceed.
        log(`Signing in with provided token ${idToken} `);
        const creds = await signInWithCustomToken(auth, idToken);
        log(`Signed in with provided token: ${creds} `);
    } catch (error: any) {
        log(
            `Sign -in with provided token failed: ${error.stack} `,
        );
        post({
            type: "authError",
            message: error.stack,
        });
        throw error;
    }
}

let liveSession: LiveSession;

async function startAudioConversationWithInstruction(
    systemInstruction: string,
    idToken: string,
) {
    log("Waiting for sign in");
    let model;
    try {
        await ensureSignedIn(idToken);
        log("Signed in, starting audio session");
        model = getLiveGenerativeModel(ai, {
            model: "gemini-live-2.5-flash-preview",
            systemInstruction: systemInstruction,
            generationConfig: {
                // inputAudioTranscription: {},
                // outputAudioTranscription: {},
                responseModalities: ["AUDIO"],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: {
                            voiceName: "Aoede",
                        },
                    },
                },
            },
        });
    } catch (error: any) {
        log(`Failed to start audio session: ${error?.message || error}\n${error.stack} `);
        post({
            type: "audioError",
            message: error?.message || "Failed to start audio session",
        });
        throw error;
    }

    log("Connecting to audio session");
    liveSession = await model.connect();
    // Note: In the WebView, we don't need the controller return value.
    log("Starting audio conversation");
    try {
        log("waiting startAudioConversation")
        await startAudioConversation(liveSession);
        log("finished wait")
    } catch (error: any) {
        log(
            `Failed to start audio conversation: ${error?.message || error} `,
        );
        post({
            type: "audioError",
            message: error?.message || "Failed to start audio conversation",
        });
        throw error;
    }
    liveSession.send("(call started)");
    log("Started audio conversation");
    receiveMessages(liveSession);
}

async function receiveMessages(session: LiveSession) {
    const messageStream = session.receive();
    const userTranscription: any = [];
    const modelTranscription: any = [];
    let userFlushTimeout: any = null;
    let modelFlushTimeout: any = null;

    const postMessage = (type: any, message: any) => {
        (window as any).ReactNativeWebView?.postMessage(
            JSON.stringify({ type, message }),
        );
    };

    const flushUser = () => {
        if (userFlushTimeout) clearTimeout(userFlushTimeout);
        userFlushTimeout = null;
        if (userTranscription.length > 0) {
            postMessage("user", userTranscription.join(""));
            userTranscription.length = 0;
        }
    };
    const flushModel = () => {
        if (modelFlushTimeout) clearTimeout(modelFlushTimeout);
        modelFlushTimeout = null;
        if (modelTranscription.length > 0) {
            postMessage("gemini", modelTranscription.join(""));
            modelTranscription.length = 0;
        }
    };

    try {
        for await (const message of messageStream) {
            if (message.type === "serverContent") {
                if (message.inputTranscription?.text) {
                    flushModel();
                    userTranscription.push(message.inputTranscription.text);
                    if (userFlushTimeout) clearTimeout(userFlushTimeout);
                    userFlushTimeout = setTimeout(flushUser, 1000);
                }
                if (message.outputTranscription?.text) {
                    flushUser();
                    modelTranscription.push(message.outputTranscription.text);
                    if (modelFlushTimeout) clearTimeout(modelFlushTimeout);
                    modelFlushTimeout = setTimeout(flushModel, 1000);
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
        postMessage("ended", "");
    }
}


const handleMessage = (event: any) => {
    try {
        log(`Audio WebView received message, ${JSON.stringify(event.data)}`);
        // Handle both string and object messages
        const data =
            typeof event.data === "string"
                ? JSON.parse(event.data)
                : event.data;

        if (data.type === "start") {
            startAudioConversationWithInstruction(
                data.systemInstruction,
                data.idToken,
            );
        } else if (data.type === "stop") {
            if (liveSession) {
                liveSession.close();
            }
        }
    } catch (e: any) {
        log(`Error processing message: ${e?.message || e} `);
        if (event.data === "stop") {
            if (liveSession) {
                liveSession.close();
            }
        }
    }
};

window.addEventListener("message", handleMessage);
document.addEventListener("message", handleMessage);
// Signal readiness to the host app
post({ type: "ready" });
