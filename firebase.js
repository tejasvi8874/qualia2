import { getAuth, onAuthStateChanged, signInAnonymously } from "firebase/auth";
import { query, where, doc, onSnapshot } from "firebase/firestore";

import { initializeApp } from "firebase/app";
import { getFunctions } from "firebase/functions";
import {
  getFirestore,
  collection,
  getDocs,
  addDoc,
} from "firebase/firestore/lite";
import { getAI, getGenerativeModel, GoogleAIBackend } from "firebase/ai";

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
const functions = getFunctions(app);
const auth = getAuth(app);
signInAnonymously(auth).then((x) => console.log("signed", x));
const db = getFirestore(app);
const finishedAuth = new Promise();
const {
  promise: userPromise,
  resolve: userResolver,
  _,
} = Promise.withResolvers();
onAuthStateChanged(auth, async (user) => {
  userResolver(user);
  console.log("Autthed", user);
});

export async function sendMessage(message, toQualiaId) {
  const user = await userPromise;
  const communication = {
    selfCommunicationType: "HUMAN_TO_QUALIA",
    fromQualiaId: user.uid,
    message: message,
  };
  if (toQualiaId !== undefined) {
    communication.communication.toQualiaId = toQualiaId;
  }
  return await addDoc(collection(db, "qualiaCommunications"), {
    communication: communication,
  });
}

export async function registerCallback(clb) {
  await userPromise.then(async (user) => {
    return onSnapshot(
      query(
        collection(db, "humanCommunications"),
        where(
          "ack",
          "!=",
          "true",
          "&&",
          "communication.toQualiaId",
          "==",
          user.uid,
        ),
      ),
      async (snapshots) => {
        snapshots.forEach(async (d) => {
          await clb(d.data());
          await updateDoc(d.ref, { ack: true });
        });
      },
    );
  });
}
