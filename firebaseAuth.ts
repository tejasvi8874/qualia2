import { getAuth, browserLocalPersistence, User, onAuthStateChanged, initializeAuth } from "firebase/auth";
//@ts-ignore getReactNativePersistence is not exported https://github.com/firebase/firebase-js-sdk/issues/7584#issuecomment-1785705367
import { getReactNativePersistence } from "firebase/auth"
import {
    getFirestore,
    persistentLocalCache,
    persistentMultipleTabManager,
    initializeFirestore,
} from "firebase/firestore";
import { getAI, GoogleAIBackend, VertexAIBackend } from "firebase/ai";
import { getDatabase } from "firebase/database";
import { getInstallations } from "firebase/installations";

import { initializeApp } from "firebase/app";
import { firebaseConfig } from "./firebaseConfig";
import Constants from "expo-constants";
import { Platform } from "react-native";

export const app = initializeApp(firebaseConfig);
initializeFirestore(app, {
    localCache: Platform.OS === "web"
        ? persistentLocalCache({ tabManager: persistentMultipleTabManager() })
        : persistentLocalCache()
});
console.log(JSON.stringify({ Constants, p: Constants.platform, w: Constants.platform?.web, Platform }));
initializeAuth(app, { persistence: Platform.OS === "web" ? browserLocalPersistence : getReactNativePersistence() });
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
export const ai = getAI(app, { backend: new VertexAIBackend('global') });
export const rtdb = getDatabase(app);
export const installations = getInstallations(app);
