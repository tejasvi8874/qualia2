import {
  collection,
  CollectionReference,
  DocumentData,
  onSnapshot,
  query,
  QueryFieldFilterConstraint,
  Timestamp,
  updateDoc,
  where,
} from "firebase/firestore";

import { db, userPromise } from "./firebaseAuth";
import { Communication } from "./types";

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

export function getMessageListener(userId: string, collectionRef: CollectionReference<DocumentData, DocumentData>, communicationTypeFilter: QueryFieldFilterConstraint, callback: (communication: Communication) => Promise<void>) {
    console.log(`Registering message listener for userId: ${userId} and communicationTypeFilter: ${JSON.stringify(communicationTypeFilter)}`);
    // Filters excludes docs where the field is not set.
    const q = query(
        collectionRef,
        where("toQualiaId", "==", userId),
        communicationTypeFilter,
        where("ack", "==", false)
    );

    return onSnapshot(q, async (snapshot) => {
        console.log(`Received snapshot with ${snapshot.docs.length} documents`);
        for (const doc of snapshot.docs) {
            const data = doc.data() as Communication;
            if (data) {
                if (data.deliveryTime && data.deliveryTime.toMillis() > Date.now()) {
                    continue;
                }
                console.log(`Handling message: ${JSON.stringify(data)}`);
                callback(data).then(() => updateDoc(doc.ref, { ack: true }));
            }
        }
    });
}

