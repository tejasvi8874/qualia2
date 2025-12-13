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
    and,
    doc,
    onSnapshot,
    or,
} from "firebase/firestore";
import { getGenerativeModel, HarmBlockThreshold, HarmCategory, ObjectSchema, GenerativeModel } from "firebase/ai";


import { Communications, Communication, Contact, Contacts, QualiaDoc, Qualia, IntegrationResponse, IntegrationOperation, INTEGRATION_SCHEMA, COMMUNICATION_SCHEMA } from "./types";
import { serializeQualia, applyOperations, detectCycles, GraphValidationError, BaseGraphCorruptionError } from "./graphUtils";



/*
Runs in background, handles all communications. Designed to run on device or in cloud.
*/


import { communicationsCollection, contactsCollection, getMessageListener, getUserId, qualiaDocOperationsCollection, qualiaDocsCollection, runWithLock, getTimeToWait, waitForLockRelease } from "./firebase";
import { getContacts, getQualia } from "./firebaseClientUtils";
import { ai, db, rtdb, installations } from "./firebaseAuth";
import { ref as databaseRef, set, remove, onDisconnect } from "firebase/database";
import { getId } from "firebase/installations";
import { BASE_QUALIA } from "./constants";
import { RateLimiter, withRetry } from "./requestUtils";

export async function messageListener() {
    return getMessageListener(await getUserId(), await communicationsCollection(), or(where("fromQualiaId", "!=", await getUserId()), where("communicationType", "!=", "QUALIA_TO_HUMAN")), messageHandler, true, "seen");
}

const safetySettings = Object.values(HarmCategory).map((category) => ({ category, threshold: HarmBlockThreshold.BLOCK_NONE }));
// pro, flash, flash-lite
const proModel = (schema: ObjectSchema) => getGenerativeModel(ai, { model: "gemini-3-pro-preview", generationConfig: { responseSchema: schema, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 32768 }, }, safetySettings }, { timeout: 1200 * 1e3 });
const flashModel = (schema: ObjectSchema) => getGenerativeModel(ai, { model: "gemini-2.5-flash-preview-09-2025", generationConfig: { responseSchema: schema, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 24576 }, }, safetySettings }, { timeout: 1200 * 1e3 });
const communicationModel = flashModel(COMMUNICATION_SCHEMA);
const integrationModel = proModel(INTEGRATION_SCHEMA);

const getResponseCommunicationsRateLimiter = new RateLimiter(60);

async function getResponseCommunications(qualiaDoc: QualiaDoc, qualia: Qualia, communication: Partial<Communication>): Promise<Communications> {
    console.log("Awaiting rate limiter...");
    await getResponseCommunicationsRateLimiter.acquire();
    console.log("Rate limiter acquired");

    // Fetch pending communications for context
    const pendingCommunications = await getPendingCommunications(qualia.qualiaId);

    const serializedQualia = serializeQualia(qualiaDoc, pendingCommunications);
    const prompt = `Generate new commmunications if required, keeping previous conversations in mind:\n${JSON.stringify({ myQualiaId: qualia.qualiaId, qualia: serializedQualia, money: qualia.money, communication: communication })}`;
    console.log(`Calling Gemini with prompt: ${prompt.substring(0, 100)}...`);
    const result = await communicationModel.generateContent(prompt);
    const response = JSON.parse(result.response.text());
    console.log(`Received response from Gemini: ${JSON.stringify(response)}`);
    return response;
}

async function integrateCommunications(qualiaDoc: QualiaDoc, pendingCommunications: Communication[], errorInfo?: string): Promise<IntegrationResponse> {
    const serializedQualia = serializeQualia(qualiaDoc, pendingCommunications);
    let prompt = `Integrate pending communications into the qualia by performing a series of operations on the graph:\n${JSON.stringify({ qualia: serializedQualia })}`;
    if (errorInfo) {
        prompt += `\n\nPrevious integration attempt failed: ${errorInfo}. Please resolve.`;
    }
    console.log(`Calling Gemini for integration with prompt length: ${prompt.length}`);
    const result = await integrationModel.generateContent(prompt);
    return JSON.parse(result.response.text());
}


const MAX_COMPACTION_PROCESSING_SECONDS = 1200;
const NETWORK_DELAY_SECONDS = 2;
const COMPACTION_PROCESSING_SECONDS = 600;



/*
Keeps the same qualia doc id and just updates the content. Creates 
*/
async function performCompaction(qualiaDocRef: DocumentReference): Promise<DocumentReference> {
    const qualiaDocSnapshot = await getDoc(qualiaDocRef);
    if (!qualiaDocSnapshot.exists()) {
        throw new Error("Qualia doc does not exist for compaction");
    }
    let qualiaDoc = qualiaDocSnapshot.data() as QualiaDoc;
    if (qualiaDoc.nextQualiaDocId !== "") {
        return doc(await qualiaDocsCollection(), qualiaDoc.nextQualiaDocId);
    }

    // Compaction loop
    let serializedSize = serializeQualia(qualiaDoc).length; // Initial check without pending? Or should we include?
    // Size check should probably include pending to be accurate about "total state size"
    const pendingCommunications = await getPendingCommunications(qualiaDoc.qualiaId);
    serializedSize = serializeQualia(qualiaDoc, pendingCommunications).length;

    const THRESHOLD = 10000; // Example threshold

    while (serializedSize > THRESHOLD) {
        console.log(`Qualia size ${serializedSize} exceeds threshold ${THRESHOLD}. Triggering integration/reduction.`);

        // Refresh pending communications in loop?
        const currentPending = await getPendingCommunications(qualiaDoc.qualiaId);
        const serializedQualia = serializeQualia(qualiaDoc, currentPending);
        const prompt = `Qualia is exceeding size limit. Integrate pending communications AND perform at least one DELETE operation to reduce size:\n${JSON.stringify({ qualia: serializedQualia })}`;

        let ops: IntegrationResponse | undefined;
        let errorInfo: string | undefined;

        // Retry loop for validation/cycles
        while (true) {
            try {
                const currentPrompt = errorInfo ? prompt + `\n\nPrevious attempt failed:\n\n${errorInfo}` : prompt;
                const result = await integrationModel.generateContent(currentPrompt);
                ops = JSON.parse(result.response.text()) as IntegrationResponse;

                const newDoc = applyOperations(qualiaDoc, ops.operations);

                const cycles = detectCycles(newDoc);
                if (cycles) {
                    errorInfo = `Cycle detected: ${JSON.stringify(cycles)}. Please retry without creating cycles.`;
                    console.log(errorInfo);
                    continue;
                }

                // Success
                qualiaDoc = newDoc;
                break;

            } catch (e) {
                // Base graph corruption - fail permanently
                if (e instanceof BaseGraphCorruptionError) {
                    console.error("Base graph corruption during compaction:", e.message);
                    throw e;
                }
                // Operation validation errors - retry with context
                if (e instanceof GraphValidationError) {
                    errorInfo = e.message;
                    console.log(errorInfo);
                    continue;
                }
                throw e;
            }
        }

        // Mark integrated communications as acked
        await markCommunicationsAsAcked(currentPending);

        serializedSize = serializeQualia(qualiaDoc, []).length; // Check size of graph only? Or fetch pending again?
        // If we just acked them, they won't be pending anymore.
    }

    // After loop, save the compacted qualia to a NEW doc?
    // User said: "Convert each node and its children to a json format ... and at the end simply serialize the list of jsons."
    // "The new communications need to be integrated into the qualia ... result of integration is a list of operations"
    // "Compaction ... trigger integration process ... Stop the loop when ... under limit."

    // It seems compaction IS integration until size is small.
    // So we just update the CURRENT doc? Or create a new one?
    // Existing code creates a new doc. Let's stick to that pattern to be safe/immutable-ish.

    const newQualiaDocRef = await addDoc(await qualiaDocsCollection(), { ...qualiaDoc, nextQualiaDocId: "", createdTime: Timestamp.now() });
    console.log(`New qualia doc created: ${newQualiaDocRef.id}`);
    await updateDoc(qualiaDocRef, { nextQualiaDocId: newQualiaDocRef.id, processingBefore: null });
    return newQualiaDocRef;
}

async function qualiaCompaction(qualiaDocRef: DocumentReference): Promise<DocumentReference> {
    let nextDocRef: DocumentReference | undefined;
    let processingBefore: Timestamp | undefined;
    let timeToWait = 0;

    // Check if nextQualiaDocId exists or if locked (without claiming yet, to get wait time)
    // Actually runWithLock checkFn runs inside transaction.
    // But we need to return nextDocRef if it exists.
    // And we need to wait if locked.

    // Let's try to claim.
    const result = await runWithLock(
        qualiaDocRef,
        async (lock) => {
            try {
                const newQualiaDocRef = await performCompaction(qualiaDocRef);
                console.log(`Compaction complete. Existing doc ${qualiaDocRef.id} updated with new content.`);
                return newQualiaDocRef;
            } catch (error) {
                console.error(`Error during qualia compaction: ${qualiaDocRef.id} : ${error}`);
                throw error;
            }
        },
        COMPACTION_PROCESSING_SECONDS,
        (data) => {
            if (data.nextQualiaDocId) {
                return false;
            }
            return true;
        }
    );

    if (result) return result;

    // If we are here, we couldn't claim. Check why.
    const docSnap = await getDoc(qualiaDocRef);
    if (!docSnap.exists()) throw new Error("Qualia doc does not exist");
    const data = docSnap.data() as QualiaDoc;

    if (data.nextQualiaDocId) {
        return doc(await qualiaDocsCollection(), data.nextQualiaDocId);
    }

    if (data.processingBefore) {
        timeToWait = getTimeToWait(data.processingBefore.toMillis(), MAX_COMPACTION_PROCESSING_SECONDS);
        if (timeToWait > 0) {
            console.log(`Another client is compacting ${qualiaDocRef.id}, waiting for ${timeToWait}ms`);
            await waitForLockRelease(qualiaDocRef, timeToWait);
            return qualiaCompaction(qualiaDocRef);
        }
    }

    // If we are here, it wasn't locked (or lock expired) and no nextDoc, but runWithLock failed?
    // Maybe race condition. Retry.
    return qualiaCompaction(qualiaDocRef);
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
    let qualiaDoc = (await getDoc(qualiaDocRef)).data() as QualiaDoc;
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

    // Set receivedTime to mark when this message was processed
    if (communication.id) {
        const commRef = doc(await communicationsCollection(), communication.id);
        await updateDoc(commRef, { receivedTime: Timestamp.now() });
    }

    // Generate response communications
    const communications = await getResponseCommunications(qualiaDoc, await getQualia(qualiaId), relevantCommunication);

    const validCommunications: Communication[] = [];
    if (communications.communications.length > 0) {
        for (const comm of communications.communications) {
            validCommunications.push(await getValidCommunication(comm));
        }
    } else {
        console.log(`No new communications generated.`);
    }

    // Send outgoing messages
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

    // Trigger integration immediately
    // triggerIntegration(qualiaId);
}

const integrationStates = new Map<string, { promise: Promise<void> | null, pending: boolean }>();

async function triggerIntegration(qualiaId: string) {
    let state = integrationStates.get(qualiaId);
    console.log("triggerIntegration", { qualiaId, state })
    if (!state) {
        state = { promise: null, pending: false };
        integrationStates.set(qualiaId, state);
    }

    if (state.promise) {
        state.pending = true;
        return;
    }

    const run = async () => {
        try {
            const qualiaDocRef = await getQualiaDocRef(qualiaId);
            await attemptIntegration(qualiaDocRef, qualiaId);
        } catch (e) {
            console.error(`Error in triggered integration for ${qualiaId}:`, e);
        } finally {
            state!.promise = null;
            if (state!.pending) {
                state!.pending = false;
                triggerIntegration(qualiaId);
            } else {
                integrationStates.delete(qualiaId);
            }
        }
    };

    state.promise = run();
}

function startPendingCommunicationsListener(qualiaId: string) {
    console.log(`Starting pending communications listener for ${qualiaId}`);
    communicationsCollection().then(collection => {
        const q = query(
            collection,
            where("toQualiaId", "==", qualiaId),
            where("ack", "==", false)
        );
        onSnapshot(q, (snapshot) => {
            if (snapshot.docs.length > 0) {
                console.log(`Pending communications detected: ${snapshot.docs.length}. Triggering integration.`);
                triggerIntegration(qualiaId);
            }
        });
    });
}

export async function startIntegrationLoop(qualiaId: string) {
    console.log(`Starting integration loop for qualiaId: ${qualiaId}`);
    startPendingCommunicationsListener(qualiaId);
    while (false) {
        try {
            // Use the central trigger with debounce logic
            await triggerIntegration(qualiaId);
        } catch (e) {
            console.error("Error in integration loop:", e);
        }
        // Wait before next iteration to avoid tight loop if nothing to do, 
        // but user said "continuous loop". A small delay is probably good practice.
        await new Promise(resolve => setTimeout(resolve, 500000));
    }
}

export async function getPendingCommunications(qualiaId: string): Promise<Communication[]> {
    const q = query(
        await communicationsCollection(),
        where("toQualiaId", "==", qualiaId),
        where("ack", "==", false)
    );
    const snapshot = await getDocs(q);
    const communications: Communication[] = [];
    snapshot.forEach((doc) => {
        communications.push({ id: doc.id, ...doc.data() } as Communication);
    });
    return communications;
}

async function markCommunicationsAsAcked(communications: Communication[]) {
    const batch = [];
    for (const comm of communications) {
        if (comm.id) {
            const commRef = doc(await communicationsCollection(), comm.id);
            await updateDoc(commRef, { ack: true });
        }
    }
}

async function attemptIntegration(qualiaDocRef: DocumentReference, qualiaId: string) {
    console.log("Attemping integration");
    async function attemptIntegration(qualiaDocRef: DocumentReference, qualiaId: string) {
        console.log("Attemping integration");

        const result = await runWithLock(
            qualiaDocRef,
            async (lock) => {
                console.log(`Integration started for qualia ${qualiaId}`);
                try {
                    // Fetch fresh data
                    const docSnap = await getDoc(qualiaDocRef);
                    let qualiaDoc = docSnap.data() as QualiaDoc;

                    // Fetch pending communications
                    const pendingCommunications = await getPendingCommunications(qualiaId);

                    // Skip if no pending communications and graph is empty
                    if (pendingCommunications.length === 0 && Object.keys(qualiaDoc.nodes || {}).length === 0) {
                        console.log('No pending communications and empty graph - skipping integration');
                        // Lock will be auto-released
                        return;
                    }

                    let errorInfo: string | undefined;
                    let newDoc: QualiaDoc | undefined;

                    // Retry loop (only for operation errors, not base graph corruption)
                    let lastOperations: IntegrationOperation[] | undefined;
                    while (true) {
                        try {
                            const integrationResult = await integrateCommunications(qualiaDoc, pendingCommunications, errorInfo);
                            lastOperations = integrationResult.operations;
                            newDoc = applyOperations(qualiaDoc, integrationResult.operations);

                            const cycles = detectCycles(newDoc);
                            if (cycles) {
                                errorInfo = `Cycle detected: ${JSON.stringify(cycles)}. Please retry without creating cycles.`;
                                if (lastOperations) {
                                    errorInfo += `\nAttempted operations: ${JSON.stringify(lastOperations)}`;
                                }
                                console.log(errorInfo);
                                continue;
                            }

                            // Success
                            break;
                        } catch (e) {
                            // Base graph corruption - fail permanently, don't retry
                            if (e instanceof BaseGraphCorruptionError) {
                                console.error("Base graph corruption detected:", e.message);
                                throw e; // Propagate to caller/UI
                            }
                            // Operation validation errors - retry with context
                            if (e instanceof GraphValidationError) {
                                errorInfo = e.message;
                                console.log(errorInfo);
                                continue;
                            }
                            throw e;
                        }
                    }

                    // Success. Create new doc and link from old.
                    const newQualiaDocRef = await addDoc(await qualiaDocsCollection(), {
                        ...newDoc!,
                        nextQualiaDocId: "",
                        processingBefore: null,
                        createdTime: Timestamp.now()
                    });

                    await updateDoc(qualiaDocRef, {
                        nextQualiaDocId: newQualiaDocRef.id,
                        // processingBefore will be cleared by runWithLock auto-release, but setting nextQualiaDocId is the key here.
                        // Actually, if we set nextQualiaDocId, processingBefore is irrelevant.
                        // But runWithLock will try to clear processingBefore.
                        // That's fine.
                    });

                    console.log(`Created new qualia doc: ${newQualiaDocRef.id} from integration`);

                    // Store operations record
                    await addDoc(await qualiaDocOperationsCollection(), {
                        qualiaId: qualiaId,
                        qualiaDocId: newQualiaDocRef.id,
                        operations: lastOperations!,
                        communicationIds: pendingCommunications.map(c => c.id).filter((id): id is string => !!id),
                        createdTime: Timestamp.now()
                    });

                    // Mark communications as acked
                    await markCommunicationsAsAcked(pendingCommunications);

                    console.log("Integration successful.");

                } catch (e) {
                    console.error("Error during integration:", e);
                    throw e;
                }
            },
            COMPACTION_PROCESSING_SECONDS
        );

        if (result === undefined) {
            // Could not claim lock
            console.log("Could not claim lock for integration");
        }
    }
}

export async function getQualiaDocRef(qualiaId: string) {
    let qualiaDocRef = await getQualiaDoc(qualiaId);
    const qualiaDoc = (await getDoc(qualiaDocRef)).data() as QualiaDoc;
    const qualiaDocString = serializeQualia(qualiaDoc);
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
        if (communication.toQualiaId === undefined) {
            communication.toQualiaId = await getUserId();
        }
    } else if (communication.communicationType === "QUALIA_TO_QUALIA") {
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
            seen: false
        }
    }
    console.log(`Communication validated successfully: ${JSON.stringify(communication)}`);
    communication.ack = false;
    communication.seen = false;
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
    const q = query(
        await qualiaDocsCollection(),
        where("qualiaId", "==", qualiaId),
        where("nextQualiaDocId", "==", "")
    );
    const snapshot = await getDocs(q);
    const docs = snapshot.docs;
    if (docs.length === 0) {
        // Create initial qualia doc
        const initialQualiaDoc: QualiaDoc = { qualiaId: qualiaId, nodes: {}, nextQualiaDocId: "", createdTime: Timestamp.now() };
        return await addDoc(await qualiaDocsCollection(), initialQualiaDoc);
    }
    if (docs.length > 1) {
        throw new Error(`Unique qualia doc not found: ${docs}`);
    }
    return docs[0].ref;
}

