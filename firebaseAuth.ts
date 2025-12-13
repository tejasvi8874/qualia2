import { getAuth, setPersistence, indexedDBLocalPersistence, browserLocalPersistence, signInWithPhoneNumber, RecaptchaVerifier, User, onAuthStateChanged, initializeAuth } from "firebase/auth";
import { getReactNativePersistence } from 'firebase/auth';
import ReactNativeAsyncStorage from '@react-native-async-storage/async-storage';
import {
    getFirestore,
    persistentLocalCache,
    persistentMultipleTabManager,
    initializeFirestore,
} from "firebase/firestore";
import { getAI, GoogleAIBackend } from "firebase/ai";

import { initializeApp } from "firebase/app";
import { firebaseConfig } from "./firebaseConfig";
import Constants from "expo-constants";

const app = initializeApp(firebaseConfig);
initializeFirestore(app, {
    localCache: Constants.platform?.web
        ? persistentLocalCache({ tabManager: persistentMultipleTabManager() })
        : persistentLocalCache()
});
initializeAuth(app, { persistence: Constants.platform?.web ? browserLocalPersistence : getReactNativePersistence(ReactNativeAsyncStorage) });
export const auth = getAuth(app);
auth.useDeviceLanguage();

/**
 * Wait for a signed-in user. Resolves with the user when available or rejects after a timeout.
 * Use this instead of a one-shot promise so post-login code gets the authenticated user.
 */
export async function waitForUser(timeoutMs: number = 15000): Promise<User> {
    const existing = auth.currentUser;
    if (existing) return existing;

    return new Promise<User>((resolve, reject) => {
        const timer = setTimeout(() => {
            unsubscribe();
            reject(new Error("User not authenticated"));
        }, timeoutMs);

        const unsubscribe = onAuthStateChanged(auth, (user) => {
            if (user) {
                clearTimeout(timer);
                unsubscribe();
                resolve(user);
            }
        });
    });
}

export const db = getFirestore(app);
export const ai = getAI(app, { backend: new GoogleAIBackend() });
