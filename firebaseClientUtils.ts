import { addDoc, query, where, onSnapshot, updateDoc, getDocs, Timestamp, runTransaction, doc } from "firebase/firestore";
import { getUserId, communicationsCollection, contactsCollection, getMessageListener, qualiaCollection } from "./firebase";
import { Communication, Contact, Contacts, ContextQualia, Qualia } from "./types";
import { db } from "./firebaseAuth";
import { withRetry } from "./requestUtils";
import { updateContacts } from "./server";

export { updateContacts };



export async function sendMessage({ message, contextQualia, toQualia }: { message: string; contextQualia: ContextQualia; toQualia: ContextQualia }): Promise<void> {
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
    communicationType: "HUMAN_TO_QUALIA",
    ack: false,
  };

  await addDoc(await communicationsCollection(), communication);
}

export async function registerClientMessageClb(callback: (communication: Communication) => Promise<void>) {
  return getMessageListener(await getUserId(), await communicationsCollection(), where("communicationType", "==", "QUALIA_TO_HUMAN"), callback, false);
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
