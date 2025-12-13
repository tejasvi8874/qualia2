import {
  and,
  collection,
  CollectionReference,
  DocumentData,
  DocumentReference,
  getDoc,
  onSnapshot,
  query,
  QueryCompositeFilterConstraint,
  QueryFieldFilterConstraint,
  runTransaction,
  Timestamp,
  updateDoc,
  where,
  Transaction,
  DocumentSnapshot,
  Firestore
} from "firebase/firestore";
import { ref as databaseRef, set, remove, onDisconnect, get } from "firebase/database";
import { getId } from "firebase/installations";

import { db, waitForUser, rtdb, installations } from "./firebaseAuth";
import { Communication } from "./types";
import { withRetry } from "./requestUtils";

export async function getUserId() {
  const user = await waitForUser();
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
export async function qualiaDocOperationsCollection() {
  await getUserId();
  return collection(db, "qualiaDocOperations");
}

export function getMessageListener(userId: string, collectionRef: CollectionReference<DocumentData, DocumentData>, echoFilter: QueryCompositeFilterConstraint | QueryFieldFilterConstraint, callback: (communication: Communication) => Promise<void>, singleListener: boolean, processedField: string = "ack") {
  console.log(`Registering message listener for userId: ${userId} and communicationTypeFilter: ${JSON.stringify(echoFilter)}`);
  // Filters excludes docs where the field is not set.
  const q = query(
    collectionRef,
    and(
      where("toQualiaId", "==", userId),
      echoFilter,
      where(processedField, "==", false)
    )
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
              processData(data, doc.ref, callback, processedField);
            } else {
              callback(data).then(() => updateDoc(doc.ref, { [processedField]: true }));
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


async function processData(data: Communication, ref: DocumentReference<DocumentData, DocumentData>, callback: (communication: Communication) => Promise<void>, processedField: string): Promise<void> {
  if (data.processingBefore) {
    const processingBefore = data.processingBefore.toMillis();
    const timeToWait = getTimeToWait(processingBefore);
    if (timeToWait > 0) {
      // Deadline not hit yet, some other client is processing
      await waitForLockRelease(ref, timeToWait);
      const doc = await getDoc(ref);
      if (doc.exists() && !doc.data()![processedField]) {
        return await processData(data, ref, callback, processedField);
      }
    };
  }
  return await claimAndProcess(ref, callback, data, processedField);
}

async function claimAndProcess(ref: DocumentReference<DocumentData, DocumentData>, callback: (communication: Communication) => Promise<void>, data: Communication, processedField: string): Promise<void> {
  try {
    const result = await runWithLock(
      ref,
      async (_lockOwnerId) => {
        return await callback(data).then(() => updateDoc(ref, { [processedField]: true }));
      },
      PROCESSING_SECONDS,
      (docData) => !docData[processedField]
    );

    if (result === undefined) {
      // Fetch the latest document state to decide whether to retry, wait, or stop
      const doc = await getDoc(ref);
      if (doc.exists()) {
        const newData = { ...doc.data(), id: doc.id } as Communication;
        // If already processed, stop immediately
        if ((newData as any)[processedField]) {
          return;
        }
        // If not processed, retry with the fresh data (which might have processingBefore set)
        return await processData(newData, ref, callback, processedField);
      }
      // Doc deleted, stop
      return;
    }
  } catch (error) {
    console.error(`Error processing ${data}: ${error}`);
    throw error;
  }
}

export function getTimeToWait(processingBefore: number, maxProcessingSeconds: number = MAX_PROCESSING_SECONDS) {
  const waitTime = processingBefore - Date.now() + NETWORK_DELAY_SECONDS * 1e3;
  const isValidProcessingBefore = waitTime > 0 && waitTime < maxProcessingSeconds * 1e3;
  return isValidProcessingBefore ? waitTime : 0;
}

export async function checkLockInRtdb(userId: string, deviceId: string, collectionId: string, docId: string): Promise<boolean> {
  const lockRef = databaseRef(rtdb, `/locks/${userId}/${deviceId}/${collectionId}/${docId}`);
  const snapshot = await get(lockRef);
  return snapshot.exists();
}

export async function waitForLockRelease(docRef: DocumentReference, maxWaitMs: number): Promise<void> {
  console.log(`Waiting for lock release on ${docRef.id} for max ${maxWaitMs}ms`);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      resolve();
    }, maxWaitMs);

    const unsubscribe = onSnapshot(docRef, async (snapshot) => {
      const data = snapshot.data();
      if (!data || !data.processingBefore) {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
        return;
      }

      // Check if the lock owner is still alive in RTDB
      if (data.lockOwner) {
        const userId = await getUserId();
        const collectionId = docRef.parent.id;
        const isAlive = await checkLockInRtdb(userId, data.lockOwner, collectionId, docRef.id);
        if (!isAlive) {
          console.log(`Lock owner ${data.lockOwner} is dead, stopping wait for ${docRef.id}`);
          clearTimeout(timeout);
          unsubscribe();
          resolve();
        }
      }
    });
  });
}

export async function acquireLock(
  docRef: DocumentReference,
  durationSeconds: number = PROCESSING_SECONDS,
  checkFn?: (data: DocumentData) => boolean
): Promise<boolean> {
  console.log(`Acquiring lock for ${docRef.id}`);
  return await runTransaction(db, async (transaction) => {
    const doc = await transaction.get(docRef);
    if (!doc.exists()) return false;
    const data = doc.data();

    if (checkFn && !checkFn(data)) return false;

    if (data.processingBefore && getTimeToWait(data.processingBefore.toMillis(), durationSeconds * 2) > 0) {
      // Lock is held, check if owner is alive
      if (data.lockOwner) {
        const userId = await getUserId();
        const collectionId = docRef.parent.id;
        // We need to check RTDB. Since we can't do async RTDB calls inside a Firestore transaction easily 
        // (it might delay the transaction too much or be disallowed depending on client SDK strictness, 
        // but usually it's fine in JS SDK as long as we await), let's try.
        // Actually, for performance, we might want to check this *before* the transaction?
        // But we need the lockOwner from the doc.
        // Let's do it here. If it fails or takes too long, the transaction might retry.
        const isAlive = await checkLockInRtdb(userId, data.lockOwner, collectionId, docRef.id);
        if (isAlive) {
          console.log(`Lock already held for ${docRef.id} by alive owner ${data.lockOwner}`);
          return false;
        }
        console.log(`Lock held by dead owner ${data.lockOwner}, stealing lock for ${docRef.id}`);
      } else {
        console.log(`Lock held but no owner recorded for ${docRef.id}`);
        return false;
      }
    }

    transaction.update(docRef, {
      processingBefore: Timestamp.fromMillis(Date.now() + durationSeconds * 1e3),
      lockOwner: await getLockOwnerId()
    });
    console.log(`Acquired lock for ${docRef.id}`);
    return true;
  });
}

export async function runTransactionWithLockVerification<T>(
  db: Firestore,
  lockDocRef: DocumentReference,
  lockOwnerId: string,
  updateFunction: (transaction: Transaction, lockDoc: DocumentSnapshot) => Promise<T>
): Promise<T> {
  return runTransaction(db, async (transaction) => {
    const docSnap = await transaction.get(lockDocRef);
    if (!docSnap.exists()) throw new Error("Lock doc does not exist");
    const data = docSnap.data();
    if (data?.lockOwner !== lockOwnerId) {
      throw new Error(`Lock stolen. Expected ${lockOwnerId}, got ${data?.lockOwner}`);
    }
    return updateFunction(transaction, docSnap);
  });
}

export async function withDeviceLock<T>(docRef: DocumentReference, work: () => Promise<T>): Promise<T> {
  const userId = await getUserId();
  const deviceId = await getLockOwnerId();
  const collectionId = docRef.parent.id;
  const docId = docRef.id;
  const lockRef = databaseRef(rtdb, `/locks/${userId}/${deviceId}/${collectionId}/${docId}`);

  await set(lockRef, true);
  await onDisconnect(lockRef).remove();

  try {
    return await work();
  } finally {
    await onDisconnect(lockRef).cancel();
    await remove(lockRef);
  }
}

export interface Lock {
  release: () => Promise<void>;
}

export async function runWithLock<T>(
  docRef: DocumentReference,
  work: (lockOwnerId: string) => Promise<T>,
  durationSeconds: number = PROCESSING_SECONDS,
  checkFn?: (data: DocumentData) => boolean
): Promise<T | undefined> {
  // Acquire RTDB lock FIRST to signal liveness
  return await withDeviceLock(docRef, async () => {
    console.log(`Acquired device lock for ${docRef.id}`);

    if (await acquireLock(docRef, durationSeconds, checkFn)) {
      console.log(`Acquired firestore lock for ${docRef.id}`);

      let released = false;
      const release = async () => {
        if (!released) {
          released = true;
          console.log(`Releasing lock for ${docRef.id}`);
          await updateDoc(docRef, { processingBefore: null, lockOwner: null });
        }
      };

      try {
        const lockOwnerId = await getLockOwnerId();
        const result = await work(lockOwnerId);
        // Auto-release on success if not already released
        await release();
        console.log(`Released lock for ${docRef.id}`);
        return result;
      } catch (e) {
        await release();
        console.error(`Releasing lock for ${docRef.id} failed: ${e}`, e instanceof Error ? e.stack : '');
        throw e;
      }
    }
    console.debug(`Failed to acquire firestore lock for ${docRef.id}`)
    return undefined;
  });
}

let cachedLockOwnerId: string | null = null;
async function getLockOwnerId(): Promise<string> {
  if (cachedLockOwnerId) return cachedLockOwnerId;
  // always fallback to random id because refresh etc destroys existing operations. Peristent id is not needed for locks
  cachedLockOwnerId = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  // try {
  //   cachedLockOwnerId = await getId(installations);
  // } catch (e) {
  //   // Fallback for Node.js environment where indexedDB is not available
  //   console.log("Failed to get installation ID, using fallback:", e);
  //   if (!cachedLockOwnerId) {
  //     cachedLockOwnerId = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  //   }
  // }
  console.log("Lock owner ID:", cachedLockOwnerId);
  return cachedLockOwnerId!;
}
