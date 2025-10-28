import { getAuth, setPersistence, signInAnonymously, indexedDBLocalPersistence, browserLocalPersistence } from "firebase/auth";
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
import { User, onAuthStateChanged } from "firebase/auth";
import Constants from "expo-constants";
import AsyncStorage from "@react-native-async-storage/async-storage";

const firebaseConfig = {
    apiKey: "AIzaSyCtCRDHe44Q85z3Tq04NQKoNl5puxe3Nmg",
    authDomain: "tstomar-experimental.firebaseapp.com",
    databaseURL: "https://tstomar-experimental-default-rtdb.firebaseio.com",
    projectId: "tstomar-experimental",
    storageBucket: "tstomar-experimental.firebasestorage.app",
    messagingSenderId: "311770829841",
    appId: "1:311770829841:web:99a1ca05c0d01b55ce4db0",
    measurementId: "G-HDL6LDBP9G",
};


const app = initializeApp(firebaseConfig);
initializeFirestore(app, {
    localCache: Constants.platform?.web
        ? persistentLocalCache({ tabManager: persistentMultipleTabManager() })
        : persistentLocalCache()
});
export const auth = getAuth(app);


// Replace non-standard Promise.withResolvers with a small Deferred helper
type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: any) => void;
};
function createDeferred<T>(): Deferred<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: any) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}
const userAuth = createDeferred<User | null>();
onAuthStateChanged(auth, async (user: User | null) => {
    userAuth.resolve(user);
    console.log("Authed resolve", user);
});


export const userPromise = userAuth.promise;
export const db = getFirestore(app);
export const ai = getAI(app, { backend: new GoogleAIBackend() });