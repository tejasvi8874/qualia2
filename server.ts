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
    doc,
} from "firebase/firestore";
import { getGenerativeModel, HarmBlockThreshold, HarmCategory, ObjectSchema, GenerativeModel } from "firebase/ai";


import { Communications, Communication, Contact, Contacts, QualiaDoc, Qualia, CompactedQualia } from "./types";

async function generateContentNonStreaming(model: GenerativeModel, prompt: string) {
    const result = await model.generateContentStream(prompt);
    // Verify there is some content to stream

    let text = "";
    for await (const chunk of result.stream) {
        try {
            text += chunk.text();
            if (text.length % 200 === 0) {
                console.log(text)
            }
        } catch (error) {
            console.error(error);
            throw error;
        }
    }
    return { response: { text: () => text } };
}

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
    return getMessageListener(await getUserId(), await communicationsCollection(), where("communicationType", "!=", "QUALIA_TO_HUMAN"), messageHandler, true);
}

const safetySettings = Object.values(HarmCategory).map((category) => ({ category, threshold: HarmBlockThreshold.BLOCK_NONE }));
// pro, flash, flash-lite
const proModel = (schema: ObjectSchema) => getGenerativeModel(ai, { model: "gemini-2.5-pro", generationConfig: { responseSchema: schema, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 32768 }, }, safetySettings }, {timeout: 1200 * 1e3});
const communicationModel = proModel(COMMUNICATION_SCHEMA);
const compactionModel = proModel(QUALIA_SCHEMA);

const getResponseCommunicationsRateLimiter = new RateLimiter(60);

async function getResponseCommunications(qualiaDocContent: string[], qualia: Qualia, communication: Partial<Communication>): Promise<Communications> {
    console.log("Awaiting rate limiter...");
    await getResponseCommunicationsRateLimiter.acquire();
    console.log("Rate limiter acquired");
    const prompt = `Generate new commmunications if required, keeping previous conversations in mind:\n${JSON.stringify({ myQualiaId: qualia.qualiaId, qualia: qualiaDocContent, money: qualia.money, communication: communication })}`;
    console.log(`Calling Gemini with prompt: ${prompt.substring(0, 100)}...`);
    const result = await generateContentNonStreaming(communicationModel, prompt);
    const response = JSON.parse(result.response.text());
    console.log(`Received response from Gemini: ${JSON.stringify(response)}`);
    return response;
}

const MAX_COMPACTION_PROCESSING_SECONDS = 1200;
const NETWORK_DELAY_SECONDS = 2;
const COMPACTION_PROCESSING_SECONDS = 600;

function getTimeToWait(processingBefore: number) {
    const waitTime = processingBefore - Date.now() + NETWORK_DELAY_SECONDS * 1e3;
    const isValidProcessingBefore = waitTime > 0 && waitTime < MAX_COMPACTION_PROCESSING_SECONDS * 1e3;
    return isValidProcessingBefore ? waitTime : 0;
}

/*
Keeps the same qualia doc id and just updates the content. Creates 
*/
async function performCompaction(qualiaDocRef: DocumentReference): Promise<DocumentReference> {
    const qualiaDocSnapshot = await getDoc(qualiaDocRef);
    if (!qualiaDocSnapshot.exists()) {
        throw new Error("Qualia doc does not exist for compaction");
    }
    const oldQualia = qualiaDocSnapshot.data() as QualiaDoc;
    if (oldQualia.nextQualiaDocId !== "") {
        return doc(await qualiaDocsCollection(), oldQualia.nextQualiaDocId);
    }
    const prompt = `Initiate sleep:\n${JSON.stringify(oldQualia.content)}`;
    console.log(`Calling Gemini with prompt: ${prompt.substring(0, 100)}...`);
    console.log(prompt);
    const result = await generateContentNonStreaming(compactionModel, prompt);
    const parsed = JSON.parse(result.response.text()) as CompactedQualia;
    const newQualiaDocContent = parsed.qualia;

    const newQualiaDocRef = await addDoc(await qualiaDocsCollection(), { content: [newQualiaDocContent], qualiaId: oldQualia.qualiaId, nextQualiaDocId: "" });
    console.log(`New qualia doc created: ${newQualiaDocRef.id}`);
    await updateDoc(qualiaDocRef, { nextQualiaDocId: newQualiaDocRef.id, processingBefore: null });
    return newQualiaDocRef;
}

async function qualiaCompaction(qualiaDocRef: DocumentReference): Promise<DocumentReference> {
    let nextDocRef: DocumentReference | undefined;
    let processingBefore: Timestamp | undefined;
    let timeToWait = 0;

    const claimed = await runTransaction(db, async (transaction) => {
        const docSnap = await transaction.get(qualiaDocRef);
        if (!docSnap.exists()) {
            throw new Error("Qualia doc does not exist for compaction");
        }
        const data = docSnap.data() as QualiaDoc;

        if (data.nextQualiaDocId) {
            nextDocRef = doc(await qualiaDocsCollection(), data.nextQualiaDocId);
            return false;
        }

        if (data.processingBefore) {
            timeToWait = getTimeToWait(data.processingBefore.toMillis());
            if (timeToWait > 0) {
                processingBefore = data.processingBefore; // Capture the timestamp
                return false;
            }
        }

        transaction.update(qualiaDocRef, { processingBefore: Timestamp.fromMillis(Date.now() + COMPACTION_PROCESSING_SECONDS * 1e3) });
        return true;
    });

    if (nextDocRef) {
        return nextDocRef;
    }

    if (claimed) {
        console.log(`Claimed ${qualiaDocRef.id} for compaction.`);
        try {
            // withRetry is important for network errors during compaction
            const newQualiaDocRef = await performCompaction(qualiaDocRef);
            console.log(`Compaction complete. Existing doc ${qualiaDocRef.id} updated with new content.`);
            return newQualiaDocRef;
        } catch (error) {
            console.error(`Error during qualia compaction: ${qualiaDocRef.id} : ${error}`);
            throw error;
        }
    }

    if (processingBefore) {
        console.log(`Another client is compacting ${qualiaDocRef.id}, waiting for ${timeToWait}ms`);
        return await new Promise(resolve => setTimeout(resolve, timeToWait)).then(() => qualiaCompaction(qualiaDocRef));
    }

    throw new Error(`Unable to claim ${qualiaDocRef.id} for compaction`);
}

/*
    Merges the new names with the existing ones.
*/
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
    const qualiaDocRef = await getQualiaDocRef(qualiaId);
    const qualiaDoc = (await getDoc(qualiaDocRef)).data() as QualiaDoc;
    console.log(`Retrieved qualia doc: ${JSON.stringify(qualiaDoc).substring(0, 100)}...`);

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
    console.log(`For the communication:\n${JSON.stringify(communication)}\n\nGenerated below communications:\n ${JSON.stringify(validCommunications)}`)
}

async function getQualiaDocRef(qualiaId: string) {
    let qualiaDocRef = await getQualiaDoc(qualiaId);
    const qualiaDoc = (await getDoc(qualiaDocRef)).data() as QualiaDoc;
    const qualiaDocString = JSON.stringify(qualiaDoc);
    console.log("Qualia doc size: ", qualiaDocString.length);
    if (qualiaDocString.length > 2 ** 20) {
        qualiaDocRef = await qualiaCompaction(qualiaDocRef);
    }
    return qualiaDocRef;
}

async function getValidCommunication(communication: Communication): Promise<Communication> {
    console.log(`Validating communication: ${JSON.stringify(communication)}`);
    let errorMessage = "";
    communication.communicationType = communication.communicationType.trim() as Communication["communicationType"];
    if (communication.communicationType === "QUALIA_TO_HUMAN") {
        if (communication.fromQualiaId === undefined) {
            communication.fromQualiaId = await getUserId();
        } else if (communication.fromQualiaId !== await getUserId()) {
            // Sending message on some other qualia's behalf
            const contacts = await getContacts();
            const contact = contacts.find((contact) => contact.qualiaId === communication.fromQualiaId);
            if (!contact) {
                errorMessage += `The fromQualiaId for QUALIA_TO_HUMAN: ${communication.fromQualiaId} was not found in any of the previous communications. Your qualiaId is ${await getUserId()}. To send communication to your human counterpart on some other qualia's behalf, there must be atleast one communication with the other qualia to prevents incorrect qualia ID issues.\n`;
            } else if (!communication.fromQualiaName) {
                communication.fromQualiaName = contact.names[0];
            }
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
        where("nextQualiaDocId", "==", "")
    );
    const snapshot = await getDocs(q);
    const docs = snapshot.docs;
    if (docs.length === 0) {
        // Create initial qualia doc
        const initialQualiaDoc: QualiaDoc = { qualiaId: qualiaId, content: [BASE_QUALIA], nextQualiaDocId: "", };
        console.log(`Creating initial qualia doc: ${JSON.stringify(initialQualiaDoc)}`);
        return await addDoc(await qualiaDocsCollection(), initialQualiaDoc);
    }
    if (docs.length > 1) {
        console.error(`Unique qualia doc not found: ${JSON.stringify(docs)}`);
        throw new Error(`Unique qualia doc not found: ${docs}`);
    }
    console.log(`Retrieved qualia doc ref: ${docs[0].ref.path}`);
    return docs[0].ref;
}


