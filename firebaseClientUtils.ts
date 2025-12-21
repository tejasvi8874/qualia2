import { addDoc, query, where, getDocs, Timestamp, runTransaction, doc, orderBy, limit, or, onSnapshot, collection, deleteDoc } from "firebase/firestore";
import { getUserId, communicationsCollection, contactsCollection, getMessageListener, qualiaCollection } from "./firebase";
import { Communication, Contact, Contacts, ContextQualia, Qualia, FunctionCall, FunctionName } from "./types";
import { db } from "./firebaseAuth";



export async function sendMessage({ message, contextQualia, toQualia }: { message: string; contextQualia: ContextQualia; toQualia: ContextQualia }): Promise<string> {
  const userId = await getUserId();

  // build the communication object (avoid using undefined `communication`)
  const communication: Communication = {
    fromQualiaId: userId,
    fromQualiaName: contextQualia.name,
    toQualiaName: toQualia.name,
    message,
    context: `While talking to ${contextQualia.name} (id: ${contextQualia.id})`,
    toQualiaId: toQualia.id,
    deliveryTime: Timestamp.now(),
    communicationType: userId === toQualia.id ? "HUMAN_TO_QUALIA" : "HUMAN_TO_HUMAN",
    ack: false,
    seen: false,
  };

  const docRef = await addDoc(await communicationsCollection(), communication);
  return docRef.id;
}

export async function registerClientMessageClb(callback: (communication: Communication) => Promise<void>) {
  return getMessageListener(await getUserId(), await communicationsCollection(), or(where("fromQualiaId", "!=", await getUserId()), where("communicationType", "==", "QUALIA_TO_HUMAN")), callback, false, "seen", (comm) => comm.communicationType === "QUALIA_TO_HUMAN");
}

export async function getContacts(): Promise<Contact[]> {
  const q = query(
    await contactsCollection(),
    where("qualiaId", "==", await getUserId())
  );
  return await getDocs(q).then((snapshot) => {
    const contactList: Contact[][] = [];
    snapshot.forEach((doc) => {
      const contacts = doc.data() as Contacts;
      contactList.push(contacts.qualiaContacts || []);
    });
    if (contactList.length > 1) {
      throw new Error("Duplicate contacts found");
    }
    return contactList[0] || [];
  });
}

export async function getHistoricalMessages(oldestMessageTime: Timestamp, count: number): Promise<Communication[]> {
  const userId = await getUserId();
  const coll = await communicationsCollection();
  const q = query(
    coll,
    where("toQualiaId", "==", userId),
    where("communicationType", "==", "QUALIA_TO_HUMAN"),
    orderBy("deliveryTime", "desc"),
    where("deliveryTime", "<", oldestMessageTime),
    limit(count)
  );

  const snapshot = await getDocs(q);
  const messages: Communication[] = [];
  snapshot.forEach((doc) => {
    messages.push({ id: doc.id, ...doc.data() } as Communication);
  });
  return messages.reverse(); // Return in ascending time order
}

async function createQualia(qualiaId: string): Promise<Qualia> {
  const qualiaDocRef = doc(await qualiaCollection(), qualiaId);

  const createQualiaTransaction = () => runTransaction(db, async (transaction) => {
    const qualiaDoc = await transaction.get(qualiaDocRef);
    if (qualiaDoc.exists()) {
      return qualiaDoc.data() as Qualia;
    }
    // TODO: Instead of setting money here, create server side listener to for qualia creation that sets initial money.
    const newQualia: Qualia = { qualiaId, money: 100 };
    transaction.set(qualiaDocRef, newQualia);
    return newQualia;
  });
  return await createQualiaTransaction();
}

export async function getQualia(qualiaId: string): Promise<Qualia> {
  const q = query(
    await qualiaCollection(),
    where("qualiaId", "==", qualiaId)
  );
  const docs = (await getDocs(q)).docs;
  if (docs.length === 0) {
    return await createQualia(qualiaId);
  }
  if (docs.length !== 1) {
    throw new Error(`Unique Qualia with id ${qualiaId} not found: ${docs}`);
  }
  return docs[0].data() as Qualia;
}
export async function callCloudFunction(functionName: FunctionName, parameters: any): Promise<any> {
  const userId = await getUserId();
  const functionCall: FunctionCall = {
    qualiaId: userId,
    functionName,
    parameters,
    createTime: Timestamp.now(),
  };

  const docRef = await addDoc(collection(db, "functionCalls"), functionCall);

  return new Promise((resolve, reject) => {
    const unsubscribe = onSnapshot(docRef, (doc) => {
      const data = doc.data() as FunctionCall;
      if (data?.result) {
        unsubscribe();
        if (data.result.error) {
          reject(new Error(`Error processing function call ${functionName} with ${JSON.stringify(parameters)}. ID ${doc.id}:\n${data.result.error}`));
        } else {
          deleteDoc(docRef).catch(console.error);
          resolve(data.result.value);
        }
      }
    });

    // Timeout after 10 minutes
    setTimeout(() => {
      unsubscribe();
      reject(new Error("Function call timed out"));
    }, 10 * 60 * 1000);
  });
}
