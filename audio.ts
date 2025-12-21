import { initializeApp } from "firebase/app";
import {
    Auth,
    getAuth,
    signInWithCustomToken,
} from "firebase/auth";
import {
    getAI,
    AI,
    LiveSession,
    VertexAIBackend,
} from "firebase/ai";
import { firebaseConfig } from "./firebaseConfig";
// This script is self-contained and runs inside the native WebView.
// It receives the firebaseConfig and an ID token via injection/messages from App.tsx.

const post = (payload: any) =>
    (window as any).ReactNativeWebView.postMessage(JSON.stringify(payload));
const log = (message: any) => post({ type: "log", message });

// Early readiness ping so the host knows we loaded, even if init fails.
post({ type: "ready" });
let auth: Auth;
let ai: AI;

let app = initializeApp(firebaseConfig);
console.log("app init")
try {
    auth = getAuth(app);
    ai = getAI(app, { backend: new VertexAIBackend("us-central1") })
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

import { setupAudioSession } from "./audioShared";

// ...

async function startAudioConversationWithInstruction(
    systemInstruction: string,
    idToken: string,
) {
    log("Waiting for sign in");
    try {
        await ensureSignedIn(idToken);
        log("Signed in, starting audio session");
        liveSession = await setupAudioSession(ai, {
            onUserPart: (text) => post({ type: "user-part", message: text }),
            onModelPart: (text) => post({ type: "gemini-part", message: text }),
            onUserFlush: (text) => post({ type: "user", message: text }),
            onModelFlush: (text) => post({ type: "gemini", message: text }),
            onEnded: () => post({ type: "ended", message: "" }),
            onUnknownMessage: (msg) => post({ type: "serverMessage", message: msg }),
        }, systemInstruction);
    } catch (error: any) {
        log(`Failed to start audio session: ${error?.message || error}\n${error.stack} `);
        post({
            type: "audioError",
            message: error?.message || "Failed to start audio session",
        });
        throw error;
    }

    log("Started audio conversation");
}


const handleMessage = (event: any) => {
    try {
        log(`Audio WebView received message, ${JSON.stringify(event.data)}`);
        // Handle both string and object messages
        const data =
            typeof event.data === "string"
                ? JSON.parse(event.data)
                : event.data;

        switch (data.type) {
            case "start":
                startAudioConversationWithInstruction(
                    data.systemInstruction,
                    data.idToken,
                );
            case "stop":
                if (liveSession) {
                    liveSession.close();
                }
            case "send":
                if (liveSession) {
                    log(`Sending message to audio session: ${data.message}`);
                    liveSession.send(data.message);
                }
            default:
                throw new Error(`Unknown message type: ${data.type}`);
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
