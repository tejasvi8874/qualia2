import {
  collection,
  CollectionReference,
  DocumentData,
  DocumentReference,
  getDoc,
  onSnapshot,
  query,
  QueryFieldFilterConstraint,
  runTransaction,
  Timestamp,
  updateDoc,
  where,
} from "firebase/firestore";

import { db, userPromise } from "./firebaseAuth";
import { Communication } from "./types";
import { withRetry } from "./requestUtils";

export async function getUserId() {
  const user = await userPromise;
  if (!user) {
    throw new Error("User not authenticated");
  }
  return user.uid;
}
export async function communicationsCollection() {
  await getUserId();
  return collection(db, "communications");
}
export async function contactsCollection() {
  await getUserId();
  return collection(db, "contacts");
}
export async function qualiaCollection() {
  await getUserId();
  return collection(db, "qualia");
}
export async function qualiaDocsCollection() {
  await getUserId();
  return collection(db, "qualiaDocs");
}

export function getMessageListener(userId: string, collectionRef: CollectionReference<DocumentData, DocumentData>, communicationTypeFilter: QueryFieldFilterConstraint, callback: (communication: Communication) => Promise<void>, singleListener: boolean) {
  console.log(`Registering message listener for userId: ${userId} and communicationTypeFilter: ${JSON.stringify(communicationTypeFilter)}`);
  // Filters excludes docs where the field is not set.
  const q = query(
    collectionRef,
    where("toQualiaId", "==", userId),
    communicationTypeFilter,
    where("ack", "==", false)
  );

  return onSnapshot(q, async (snapshot) => {
    console.log(`Received snapshot with ${snapshot.docChanges().length} changes`);
    for (const change of snapshot.docChanges()) {
      if (change.type === "added") {
        // To prevent triggering when updating the processing status from this client
        // All snapshots are loaded as added on first load
        const doc = change.doc;
        const data = { ...doc.data(), id: doc.id } as Communication;
        if (data) {
          const deliveryTime = data.deliveryTime;
          const timeToWait = deliveryTime ? Math.max(0, deliveryTime.toMillis() - Date.now()) : 0;
          console.log(`Handling message in generic listener: ${JSON.stringify(data)}`);
          new Promise(resolve => setTimeout(resolve, timeToWait)).then(() => {
            if (singleListener) {
              processData(data, doc.ref, callback);
            } else {
              callback(data).then(() => updateDoc(doc.ref, { ack: true }));
            }
          });
        }
      }
    }
  });
}

const MAX_PROCESSING_SECONDS = 120
const NETWORK_DELAY_SECONDS = 2
const PROCESSING_SECONDS = 60


async function processData(data: Communication, ref: DocumentReference<DocumentData, DocumentData>, callback: (communication: Communication) => Promise<void>): Promise<void> {
  if (data.processingBefore) {
    const processingBefore = data.processingBefore.toMillis();
    const timeToWait = getTimeToWait(processingBefore);
    if (timeToWait > 0) {
      // Deadline not hit yet, some other client is processing
      await new Promise(resolve => setTimeout(resolve, timeToWait));
      const doc = await getDoc(ref);
      if (doc.exists() && !doc.data()!.ack) {
        return await processData(data, ref, callback);
      }
    };
  }
  return await claimAndProcess(ref, callback, data);
}

async function claimAndProcess(ref: DocumentReference<DocumentData, DocumentData>, callback: (communication: Communication) => Promise<void>, data: Communication): Promise<void> {
  try {
    const claimed = await runTransaction(db, async (transaction) => {
      const doc = await transaction.get(ref);
      if (!doc.exists()) {
        return false;
      }
      const data = doc.data() as Communication;
      if (data.ack) {
        return false;
      }
      if (data.processingBefore && getTimeToWait(data.processingBefore.toMillis()) > 0) {
        return false;
      }
      transaction.update(ref, { processingBefore: Timestamp.fromMillis(Date.now() + PROCESSING_SECONDS * 1e3) });
      return true;
    });
    if (claimed) {
      return await callback(data).then(() => updateDoc(ref, { ack: true }));
    } else {
      return await processData(data, ref, callback);
    }
  } catch (error) {
    console.error(`Error processing ${data}: ${error}`);
    throw error;
  }
}

function getTimeToWait(processingBefore: number) {
  const waitTime = processingBefore - Date.now() + NETWORK_DELAY_SECONDS * 1e3;
  const isValidProcessingBefore = waitTime > 0 && waitTime < MAX_PROCESSING_SECONDS * 1e3;
  return isValidProcessingBefore ? waitTime : 0;
}

