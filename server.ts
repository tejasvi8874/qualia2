import {
    addDoc,
    query,
    where,
    updateDoc,
    getDocs,
    Timestamp,
    DocumentReference,
    getDoc,
    arrayUnion,
    runTransaction,
} from "firebase/firestore";
import { getGenerativeModel } from "firebase/ai";


import { Communications, Communication, Contact, Contacts, QualiaDoc, Qualia, CompactedQualia } from "./types";

/*
Runs in background, handles all communications. Designed to run on device or in cloud.
*/


import { communicationsCollection, contactsCollection, getMessageListener, getUserId, qualiaDocsCollection } from "./firebase";
import { getContacts, getQualia } from "./firebaseClientUtils";
import { ai, db } from "./firebaseAuth";
import { COMMUNICATION_SCHEMA } from "./types";
import { QUALIA_SCHEMA } from "./types";
import { BASE_QUALIA } from "./constants";
import { RateLimiter, withRetry } from "./requestUtils";

export async function messageListener() {
    return getMessageListener(await getUserId(), await communicationsCollection(), where("communicationType", "!=", "QUALIA_TO_HUMAN"), messageHandler);
}

// pro, flash, flash-lite
const communicationModel = getGenerativeModel(ai, { model: "gemini-2.5-pro", generationConfig: { responseMimeType: "application/json", responseSchema: COMMUNICATION_SCHEMA, thinkingConfig: {thinkingBudget: -1} } });
const compactionModel = getGenerativeModel(ai, { model: "gemini-2.5-flash-lite", generationConfig: { responseMimeType: "application/json", responseSchema: QUALIA_SCHEMA, thinkingConfig: {thinkingBudget: -1} } });

const getResponseCommunicationsRateLimiter = new RateLimiter(60);

async function getResponseCommunications(qualiaDocContent: string[], qualia: Qualia, communication: Partial<Communication>): Promise<Communications> {
    console.log("Awaiting rate limiter...");
    await getResponseCommunicationsRateLimiter.acquire();
    console.log("Rate limiter acquired");
    const prompt = `Generate new commmunications if required, keeping previous conversations in mind:\n${JSON.stringify({ myQualiaId: qualia.qualiaId, qualia: qualiaDocContent, money: qualia.money, communication: communication })}`;
    console.log(`Calling Gemini with prompt: ${prompt.substring(0, 100)}...`);
    const result = await communicationModel.generateContent(prompt);
    const response = JSON.parse(result.response.text());
    console.log(`Received response from Gemini: ${JSON.stringify(response)}`);
    return response;
}

async function performCompaction(qualiaDocRef: DocumentReference): Promise<string> {
    let newQualiaDocContent;
    await runTransaction(db, async (transaction) => {
        const qualiaDocSnapshot = await transaction.get(qualiaDocRef);
        if (!qualiaDocSnapshot.exists()) {
            throw new Error("Qualia doc does not exist for compaction");
        }
        const oldQualia = qualiaDocSnapshot.data() as QualiaDoc;
        const prompt = `Compact the below qualia:\n${JSON.stringify(oldQualia.content)}`;
        console.log(`Calling Gemini with prompt: ${prompt.substring(0, 100)}...`);
        const result = await compactionModel.generateContent(prompt);
        const parsed = JSON.parse(result.response.text()) as CompactedQualia;
        newQualiaDocContent = parsed.qualia;

        const archivedDocRef = await addDoc(await qualiaDocsCollection(), oldQualia);
        console.log(`Archived old qualia doc to: ${archivedDocRef.id}`);
        transaction.update(qualiaDocRef, {
            content: [newQualiaDocContent],
            prevQualiaDocId: archivedDocRef.id,
        });
    });
    if (!newQualiaDocContent) {
        throw new Error("Could not get archived document reference ID.");
    }
    return newQualiaDocContent;
}

async function qualiaCompaction(qualiaDocRef: DocumentReference): Promise<string> {
    try {
        const compactionLogic = () => performCompaction(qualiaDocRef);
        const newQualiaDocContent = await withRetry(compactionLogic);
        console.log(`Compaction complete. Existing doc ${qualiaDocRef.id} updated with new content.`);
        return newQualiaDocContent;
    } catch (error) {
        console.error(`Error during qualia compaction: ${qualiaDocRef.id} : ${error}`);
        throw error;
    }
}

export async function updateContacts(contacts: Contact[]): Promise<void> {
    console.log(`Updating contacts: ${JSON.stringify(contacts)}`);
    const q = query(
        await contactsCollection(),
        where("qualiaId", "==", await getUserId())
    );
    const snapshot = await getDocs(q);
    const docs = snapshot.docs;
    if (docs.length === 0) {
        await addDoc(await contactsCollection(), {
            qualiaId: await getUserId(),
            qualiaContacts: contacts,
        });
    } else if (docs.length === 1) {
        // Later rewrite this to extract compaction in a separate function
        const docRef = docs[0].ref;
        const existingContacts = docs[0].data() as Contacts;
        const existingQualiaContacts = existingContacts.qualiaContacts || [];
        // merge existing contacts with new contacts
        const qualiaIdMap = new Map<string, Contact>();

        for (const contact of existingQualiaContacts) {
            qualiaIdMap.set(contact.qualiaId, contact);
        }
        for (const contact of contacts) {
            if (qualiaIdMap.has(contact.qualiaId)) {
                const newContact = qualiaIdMap.get(contact.qualiaId)!;
                newContact.names.push(...contact.names);
                newContact.lastContactTime = contact.lastContactTime
                qualiaIdMap.set(contact.qualiaId, newContact);
            } else {
                qualiaIdMap.set(contact.qualiaId, contact);
            }
        }
        for (const [qualiaId, contact] of qualiaIdMap) {
            contact.names = Array.from(new Set(contact.names));
            qualiaIdMap.set(qualiaId, contact);
        }
        const mergedContacts = Array.from(qualiaIdMap.values());
        await updateDoc(docRef, { qualiaContacts: mergedContacts });
        console.log(`Contacts updated successfully`);
    } else {
        console.error("Duplicate contacts found");
        throw new Error("Duplicate contacts found");
    }
}

async function messageHandler(communication: Communication): Promise<void> {
    console.log(`Handling message on communication: ${JSON.stringify(communication)}`);
    const qualiaId = communication.toQualiaId;
    /*
    get qualia doc data
    read the message
    create new communications
    */
    const qualiaDocRef = await getQualiaDoc(qualiaId);
    const qualiaDocSnapshot = await getDoc(qualiaDocRef);
    const qualiaDoc = qualiaDocSnapshot.data() as QualiaDoc;
    const qualiaDocString = JSON.stringify(qualiaDoc);
    if (qualiaDocString.length > 2 ** 20 / 4) {
        await qualiaCompaction(qualiaDocRef);
    }
    console.log(`Retrieved qualia doc: ${qualiaDocString.substring(0, 100)}...`);
    let relevantCommunication: Partial<Communication>;
    let contacts: Contact[] = [];
    if (communication.communicationType === "HUMAN_TO_QUALIA") {
        relevantCommunication = {
            communicationType: communication.communicationType,
            message: communication.message,
            context: communication.context
        };
    }
    else {
        relevantCommunication = {
            fromQualiaId: communication.fromQualiaId,
            fromQualiaName: communication.fromQualiaName,
            money: communication.money,
            message: communication.message,
            context: communication.context
        };
        if (!communication.fromQualiaId) {
            throw new Error("Missing fromQualiaId");
        }
        contacts = [{
            names: communication.fromQualiaName ? [communication.fromQualiaName] : [],
            qualiaId: communication.fromQualiaId,
            lastContactTime: Timestamp.now()
        }];
    }
    relevantCommunication.isoDeliveryTime = new Date().toISOString();
    const communications = await getResponseCommunications(qualiaDoc.content, await getQualia(qualiaId), relevantCommunication);
    if (communications.communications.length === 0) {
        console.log(`No new communications generated.`);
        return;
    }
    const validCommunications: Communication[] = [];
    for (const comm of communications.communications) {
        validCommunications.push(await getValidCommunication(comm));
    }
    await updateDoc(qualiaDocRef, {
        content: arrayUnion(...([communication, ...validCommunications]
            .filter((comm) => !(comm.toQualiaId === qualiaId && comm.communicationType === "QUALIA_TO_QUALIA"))
            .map((comm) => {
                if (comm.deliveryTime) {
                    comm = { ...comm, isoDeliveryTime: comm.deliveryTime.toDate().toISOString() };
                    delete comm.deliveryTime;
                }
                return JSON.stringify(comm);
            }))),
    });
    console.log(`Qualia doc updated with new communications.`);
    // TODO: Consider adding timestamps to conversations. It is not delivery time.
    await Promise.all(validCommunications.map(comm => communicationsCollection().then(
        collection => addDoc(collection, comm))));
    console.log(`All communications added to collection.`);

    for (const comm of communications.communications) {
        if (comm.toQualiaName && comm.toQualiaId) {
            contacts.push({
                names: [comm.toQualiaName],
                qualiaId: comm.toQualiaId,
                lastContactTime: Timestamp.now(),
            });
        }
    }
    await updateContacts(contacts);
    console.log(`Message handling complete for communication: ${JSON.stringify(communication)}`);
}

async function getValidCommunication(communication: Communication): Promise<Communication> {
    console.log(`Validating communication: ${JSON.stringify(communication)}`);
    let errorMessage = "";
    communication.communicationType = communication.communicationType.trim() as Communication["communicationType"];
    if (communication.communicationType === "QUALIA_TO_HUMAN") {
        if (communication.fromQualiaId === undefined) {
            communication.fromQualiaId = await getUserId();
        } else if (communication.fromQualiaId !== await getUserId()) {
            errorMessage += `Invalid fromQualiaId for QUALIA_TO_HUMAN: ${communication.fromQualiaId}. Your qualiaId is ${await getUserId()}.\n`;
        }
        if (communication.toQualiaId === undefined) {
            communication.toQualiaId = await getUserId();
        } else if (communication.toQualiaId !== await getUserId()) {
            errorMessage += `Invalid toQualiaId for QUALIA_TO_HUMAN: ${communication.toQualiaId}. Your qualiaId is ${await getUserId()}.\n`;
        }
    } else if (communication.communicationType === "QUALIA_TO_QUALIA") {
        if (communication.fromQualiaId === undefined) {
            communication.fromQualiaId = await getUserId();
        } else if (communication.fromQualiaId !== await getUserId()) {
            errorMessage += `Invalid fromQualiaId for QUALIA_TO_QUALIA: ${communication.fromQualiaId}. Your qualiaId is ${await getUserId()}.\n`;
        }
        if (communication.toQualiaId === undefined) {
            if (communication.toQualiaName) {
                const qualiaIds = getContacts().then(
                    (contacts) => contacts.filter(
                        (contact) => contact.names.map((name) => name.toLowerCase()).includes(communication.toQualiaName!.toLowerCase()))
                        .map((contact) =>
                            contact.qualiaId
                        ));
                const uniqueQualiaIds = Array.from(new Set(await qualiaIds));
                if (uniqueQualiaIds.length === 0) {
                    errorMessage += `No qualiaId found for toQualiaName: ${communication.toQualiaName}\n`;
                } else if (uniqueQualiaIds.length > 1) {
                    errorMessage += `Multiple qualiaIds found for toQualiaName: ${communication.toQualiaName}: ${uniqueQualiaIds.join(", ")}\n`;
                } else {
                    communication.toQualiaId = uniqueQualiaIds[0];
                }
            } else {
                errorMessage += "Missing toQualiaName for QUALIA_TO_QUALIA\n";
            }
        }
        if (!communication.toQualiaId) {
            errorMessage += "Missing toQualiaId for QUALIA_TO_QUALIA. Need at least one of toQualiaId or toQualiaName.\n";
        }
        if (communication.money !== undefined && communication.money <= 0) {
            errorMessage += `Invalid money amount for QUALIA_TO_QUALIA: ${communication.money}. Must be positive.\n`;
        }
    } else {
        // No other communication type is valid including HUMAN_TO_QUALIA
        errorMessage += `Invalid communicationType: ${communication.communicationType}\n`;
    }
    if (communication.fromQualiaId === undefined) {
        communication.fromQualiaId = await getUserId();
    } else if (communication.fromQualiaId !== await getUserId()) {
        errorMessage += `Invalid fromQualiaId: ${communication.fromQualiaId}. Your qualiaId is ${await getUserId()}.\n`;
    }
    if (errorMessage.length > 0) {
        console.error(`Error processing communication: ${errorMessage}`);
        return {
            fromQualiaId: "SYSTEM",
            fromQualiaName: "SYSTEM",
            toQualiaId: await getUserId(),
            toQualiaName: communication.fromQualiaName,
            message: `Error processing communication:\n${errorMessage}`,
            communicationType: "QUALIA_TO_QUALIA",
            deliveryTime: Timestamp.now(),
            ack: false,
        }
    }
    console.log(`Communication validated successfully: ${JSON.stringify(communication)}`);
    communication.ack = false;
    if (communication.delaySeconds && communication.delaySeconds > 0) {
        communication.deliveryTime = Timestamp.fromMillis(Date.now() + communication.delaySeconds * 1000);
    } else if (communication.isoDeliveryTime) {
        communication.deliveryTime = Timestamp.fromDate(new Date(communication.isoDeliveryTime));
    } else {
        communication.deliveryTime = Timestamp.now();
    }
    return communication;
}

async function getQualiaDoc(qualiaId: string): Promise<DocumentReference> {
    console.log(`Getting qualia doc for qualiaId: ${qualiaId}`);
    const q = query(
        await qualiaDocsCollection(),
        where("qualiaId", "==", qualiaId),
        where("prevQualiaDocId", "==", "")
    );
    const snapshot = await getDocs(q);
    const docs = snapshot.docs;
    if (docs.length === 0) {
        // Create initial qualia doc
        const initialQualiaDoc: QualiaDoc = { qualiaId: qualiaId, content: [BASE_QUALIA], prevQualiaDocId: "", };
        console.log(`Creating initial qualia doc: ${JSON.stringify(initialQualiaDoc)}`);
        return await addDoc(await qualiaDocsCollection(), initialQualiaDoc);
    }
    if (docs.length > 1) {
        console.error(`Unique qualia doc not found: ${docs}`);
        throw new Error(`Unique qualia doc not found: ${docs}`);
    }
    console.log(`Retrieved qualia doc ref: ${docs[0].ref.path}`);
    return docs[0].ref;
}


