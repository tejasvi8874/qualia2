import { initializeApp } from "firebase/app";
import { getAuth, signInWithPhoneNumber, RecaptchaVerifier } from "firebase/auth";
import { firebaseConfig } from "./firebaseConfig";

// This script is self-contained and runs inside the native WebView.
// It receives the firebaseConfig via injection from App.tsx.

const post = (payload: any) => (window as any).ReactNativeWebView.postMessage(JSON.stringify(payload));
const log = (message: any) => post({ type: 'log', message });

// Early ping so host knows the WebView booted, even if init fails.
post({ type: 'ready' });
log('Auth WebView script loaded');

let app: any;
let auth: any;

const ensureApp = () => {
    if (app) return;
    try {
        app = initializeApp(firebaseConfig);
        auth = getAuth(app);
        log('Auth WebView initialized');
        post({ type: 'ready' });
    } catch (err: any) {
        post({ type: 'authErrorT', message: `${err}\n${err.stack}` });
    }
};

const getVerifier = () => {
    if (!(window as any).recaptchaVerifier) {
        (window as any).recaptchaVerifier = new RecaptchaVerifier(auth, 'recaptcha-container', {
            size: 'invisible',
            'callback': (token: any) => log(`reCAPTCHA completed: ${token ? 'token received' : 'no token'}`),
            'expired-callback': () => log('reCAPTCHA expired; resetting'),
        });
    }
    return (window as any).recaptchaVerifier;
};

const startPhoneAuth = async (phoneNumber: string) => {
    try {
        log("ensure app")
        ensureApp();
        log("get verifier")
        const verifier = getVerifier();
        post({ type: 'log', message: `Starting phone auth for ${phoneNumber}` });
        // Trigger the invisible challenge if required
        try {
            await verifier.verify();
        } catch (verifyErr: any) {
            post({ type: 'log', message: `reCAPTCHA verify failed: ${verifyErr}n${verifyErr.stack}` });
            throw verifyErr;
        }
        log("sign in with phone number")
        const confirmationResult = await signInWithPhoneNumber(auth, phoneNumber, verifier);
        post({ type: 'log', message: `Sent verification code to ${phoneNumber}. Got result ${confirmationResult}` });
        post({ type: 'verificationId', verificationId: confirmationResult.verificationId });
    } catch (error: any) {
        post({ type: 'log', message: `Phone auth error: ${error?.message || error}` });
        post({ type: 'authErrorT', message: `${error}\n${error.stack}` });
        try {
            (window as any).recaptchaVerifier?.clear();
            (window as any).recaptchaVerifier = null;
        } catch (e) { }
    }
};

const handleMessage = (event: any) => {
    try {
        log(`Received message event: ${typeof event.data} ${JSON.stringify(event.data).slice(0, 100)}`);
        if (typeof event.data === 'string' && event.data.slice(0, 2) === '!_') return;
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (data?.type === 'startPhoneAuth' && data.phoneNumber) {
            log(`Handling startPhoneAuth for ${data.phoneNumber}`);
            startPhoneAuth(data.phoneNumber);
        }
    } catch (error: any) {
        post({ type: 'authErrorK', message: `${event.data}\n${error}\n${error.stack}` || 'Invalid message' });
    }
};

window.addEventListener('message', handleMessage);
document.addEventListener('message', handleMessage);

// Signal readiness on load
ensureApp();
