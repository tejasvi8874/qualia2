import { getAuth, setPersistence, indexedDBLocalPersistence, browserLocalPersistence, signInWithPhoneNumber, RecaptchaVerifier, User, onAuthStateChanged } from "firebase/auth";
import {
    getFirestore,
    persistentLocalCache,
    persistentMultipleTabManager,
    collection,
    DocumentData,
    QuerySnapshot,
    DocumentReference,
    serverTimestamp,
    initializeFirestore,
    Timestamp,
} from "firebase/firestore";
import { getAI, getGenerativeModel, GoogleAIBackend } from "firebase/ai";

import { initializeApp } from "firebase/app";
import { getFunctions } from "firebase/functions";
import { Communications } from "./types";
import Constants from "expo-constants";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { firebaseConfig } from "./firebaseConfig";

const app = initializeApp(firebaseConfig);
initializeFirestore(app, {
    localCache: Constants.platform?.web
        ? persistentLocalCache({ tabManager: persistentMultipleTabManager() })
        : persistentLocalCache()
});
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
