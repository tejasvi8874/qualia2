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

import { AUDIO_GENERATION_CONFIG, processStreamMessages, connectAndStartAudioSession } from "./audioShared";

// ...

async function startAudioConversationWithInstruction(
    systemInstruction: string,
    idToken: string,
) {
    log("Waiting for sign in");
    try {
        await ensureSignedIn(idToken);
        log("Signed in, starting audio session");
        liveSession = await connectAndStartAudioSession(ai, systemInstruction);
    } catch (error: any) {
        log(`Failed to start audio session: ${error?.message || error}\n${error.stack} `);
        post({
            type: "audioError",
            message: error?.message || "Failed to start audio session",
        });
        throw error;
    }

    log("Started audio conversation");
    liveSession.send("(call started)");
    receiveMessages(liveSession);
}

async function receiveMessages(session: LiveSession) {
    const postMessage = (type: any, message: any) => {
        (window as any).ReactNativeWebView?.postMessage(
            JSON.stringify({ type, message }),
        );
    };

    await processStreamMessages(session, {
        onUserPart: (text) => postMessage("user-part", text),
        onModelPart: (text) => postMessage("gemini-part", text),
        onUserFlush: (text) => postMessage("user", text),
        onModelFlush: (text) => postMessage("gemini", text),
        onEnded: () => postMessage("ended", ""),
    });
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
        } else if (data.type === "send") {
            if (liveSession) {
                log(`Sending message to audio session: ${data.message}`);
                liveSession.send(data.message);
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
