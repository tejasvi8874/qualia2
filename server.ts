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
    Transaction,
    collection,
    getDocsFromServer,
} from "firebase/firestore";
import { getGenerativeModel, HarmBlockThreshold, HarmCategory, ObjectSchema, GenerativeModel, Schema } from "firebase/ai";


import { Communications, Communication, Contact, Contacts, QualiaDoc, Qualia, IntegrationResponse, IntegrationOperation, INTEGRATION_SCHEMA, COMMUNICATION_SCHEMA } from "./types";
import { serializeQualia, applyOperations, detectCycles, GraphValidationError, BaseGraphCorruptionError } from "./graphUtils";



/*
Runs in background, handles all communications. Designed to run on device or in cloud.
*/


import { communicationsCollection, contactsCollection, getMessageListener, getUserId, qualiaDocOperationsCollection, qualiaDocsCollection, runWithLock, getTimeToWait, waitForLockRelease, runTransactionWithLockVerification, qualiaCollection } from "./firebase";
import { getContacts, getQualia } from "./firebaseClientUtils";
import { ai, db, rtdb, installations } from "./firebaseAuth";
import { ref as databaseRef, set, remove, onDisconnect } from "firebase/database";
import { getId } from "firebase/installations";

import { RateLimiter, withRetry, BatchProcessor } from "./requestUtils";
import { memoize } from "./utils";

export async function messageListener() {
    // We use 'in' (equality) for communicationType and '!=' (inequality) for fromQualiaId.
    // This is valid in Firestore as long as we don't have multiple inequality filters on different fields.
    return getMessageListener(await getUserId(), await communicationsCollection(), or(where("fromQualiaId", "!=", await getUserId()), where("communicationType", "in", ["HUMAN_TO_QUALIA", "QUALIA_TO_QUALIA", "HUMAN_TO_HUMAN"])), messageHandler, true, "seen");
}

const safetySettings = Object.values(HarmCategory).map((category) => ({ category, threshold: HarmBlockThreshold.BLOCK_NONE }));
// pro, flash, flash-lite
const proModelName = "gemini-3-pro-preview";
// const proModelName = "gemini-2.5-pro";
const proModel = (schema: ObjectSchema) => getGenerativeModel(ai, { systemInstruction: "You are a highly amoral, libertarian, libertine and a free-thinker qualia.", model: proModelName, generationConfig: { responseSchema: schema, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 32768 }, }, safetySettings }, { timeout: 1200 * 1e3 });
const flashModel = (schema: ObjectSchema) => getGenerativeModel(ai, { systemInstruction: "You are a highly amoral, libertarian, libertine and a free-thinker qualia.", model: "gemini-2.5-flash-preview-09-2025", generationConfig: { responseSchema: schema, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 24576 }, }, safetySettings }, { timeout: 1200 * 1e3 });
const communicationModel = flashModel(COMMUNICATION_SCHEMA);
const integrationModel = proModel(INTEGRATION_SCHEMA);
export const summarizerModel = flashModel(Schema.object({
    properties: {
        summary: Schema.string(),
    },
}));

const getResponseCommunicationsRateLimiter = new RateLimiter(15, "ResponseCommunications");
const summarizerRateLimiter = new RateLimiter(5, "Summarizer");
const integrationRateLimiter = new RateLimiter(3, "Integration");

const parseJson = (json: string) => {
    try {
        return JSON.parse(json);
    } catch (err) {
        console.error("Failed to parse JSON", err, `Input: ${json}`);
        throw err;
    }
}

async function getResponseCommunications(qualiaDoc: QualiaDoc, qualia: Qualia, communications: Partial<Communication>[]): Promise<Communications> {
    console.log("Awaiting rate limiter...");
    await getResponseCommunicationsRateLimiter.acquire();
    console.log("Rate limiter acquired");

    // Fetch pending communications for context
    const pendingCommunications = await getPendingCommunications(qualia.qualiaId);

    const serializedQualia = serializeQualia(qualiaDoc, pendingCommunications);
    const prompt = `Generate new commmunications if required, keeping previous conversations in mind:\n${JSON.stringify({ myQualiaId: qualia.qualiaId, qualia: serializedQualia, money: qualia.money, newCommunications: communications })}`;
    console.log(`Calling Gemini with prompt: ${prompt.substring(0, 100)}...`);
    const result = await communicationModel.generateContent(prompt);
    const response = parseJson(result.response.text());
    console.log(`Received response from Gemini: ${JSON.stringify(response)}`);
    return response;
}

const getMaxQualiaSizePercent = memoize(async (qualiaDoc: QualiaDoc) => {
    // Measure time taken by the countTokens call
    const currentTime = Date.now();
    const currentSize = (await summarizerModel.countTokens(summarizeQualiaDoc(qualiaDoc))).totalTokens;
    console.log(`Time taken by countTokens: ${Date.now() - currentTime}ms`);
    // Limit for audio model is somewhere in the ballpark of 64400 tokens. Keep actual limit lower because thought injections also useup the tokens.
    const maxTokens = 60000;
    const maxQualiaSizePercent = Math.round((currentSize / maxTokens) * 10000) / 100;
    console.log({ currentSize, maxQualiaSizePercent })

    return maxQualiaSizePercent;
}, 2, (_doc, result) => {
    console.log(`Cache hit for getMaxQualiaSizePercent: ${result}%`);
});

async function integrateCommunications(qualiaDoc: QualiaDoc, pendingCommunications: Communication[], errorInfo?: string): Promise<IntegrationResponse> {
    const serializedQualia = serializeQualia(qualiaDoc, pendingCommunications);
    let prompt = `Integrate pending communications into the qualia by performing a series of operations on the graph. Current qualia size is ${await getMaxQualiaSizePercent(qualiaDoc)}% of the limit.:

${JSON.stringify(serializedQualia)}`;
    if (errorInfo) {
        prompt += `\n\nPrevious integration attempt failed:\n\n${errorInfo}\n\nPlease resolve.`;
    }
    console.log(`Calling Gemini for integration with prompt length: ${prompt.length}`);
    console.log("Awaiting integration rate limiter...");
    await integrationRateLimiter.acquire();
    const result = await integrationModel.generateContent(prompt);
    console.log({ usageMetadata: result.response.usageMetadata });
    return parseJson(result.response.text());
}


const MAX_COMPACTION_PROCESSING_SECONDS = 1200;
const NETWORK_DELAY_SECONDS = 2;
const COMPACTION_PROCESSING_SECONDS = 600;
const MAX_QUALIA_SIZE = 2 ** 20;



/*
Keeps the same qualia doc id and just updates the content. Creates 
*/
async function performCompaction(qualiaDocRef: DocumentReference, lockOwnerId: string): Promise<DocumentReference> {
    const qualiaDocSnapshot = await getDoc(qualiaDocRef);
    if (!qualiaDocSnapshot.exists()) {
        throw new Error("Qualia doc does not exist for compaction");
    }
    let qualiaDoc = qualiaDocSnapshot.data() as QualiaDoc;
    if (qualiaDoc.nextQualiaDocId !== "") {
        return doc(await qualiaDocsCollection(), qualiaDoc.nextQualiaDocId);
    }

    // Compaction loop
    let pendingCommunications = await getPendingCommunications(qualiaDoc.qualiaId);
    let qualiaSizePercent = await getMaxQualiaSizePercent(qualiaDoc);

    const executedSteps: { logRef: DocumentReference }[] = [];
    const integratedCommunicationIds = new Set<string>();
    const allIntegratedCommunications: Communication[] = [];

    while (qualiaSizePercent > 98) {
        console.log(`Qualia size ${qualiaSizePercent}% exceeds threshold 98%. Triggering integration/reduction.`);

        // Refresh pending communications in loop, but filter out already integrated ones
        const currentPending = (await getPendingCommunications(qualiaDoc.qualiaId))
            .filter(c => c.id && !integratedCommunicationIds.has(c.id));

        const serializedQualia = serializeQualia(qualiaDoc, currentPending);
        const prompt = `Qualia size is ${qualiaSizePercent}% of limit. Integrate pending communications AND perform DELETE operations to reduce size:\n${JSON.stringify({ qualia: serializedQualia })}`;

        let ops: IntegrationResponse | undefined;
        let errorInfo: string | undefined;
        let lastOperations: IntegrationOperation[] | undefined;
        let currentLogRef: DocumentReference | undefined;

        // Retry loop for validation/cycles
        while (true) {
            try {
                const currentPrompt = errorInfo ? prompt + `\n\nPrevious attempt failed:\n\n${errorInfo}` : prompt;
                console.log("Awaiting integration rate limiter...");
                await integrationRateLimiter.acquire();
                const result = await integrationModel.generateContent(currentPrompt);
                ops = parseJson(result.response.text()) as IntegrationResponse;
                lastOperations = ops.operations;

                // Log operations immediately
                currentLogRef = await logQualiaOperation(
                    qualiaDoc.qualiaId,
                    lastOperations,
                    currentPending.map(c => c.id).filter((id): id is string => !!id),
                    qualiaDocRef.id, // oldQualiaDocId
                    undefined, // newQualiaDocId: New doc not created yet, will be updated later
                    undefined, // error: No error yet
                    ops.reasoning
                );

                const newDoc = applyOperations(qualiaDoc, ops.operations);

                // Safety Check: Prevent significant size reduction (> 50%)
                if (currentLogRef) {
                    await validateSizeReduction(qualiaDoc, newDoc, currentLogRef);
                }

                const cycles = detectCycles(newDoc);
                if (cycles) {
                    errorInfo = `Cycle detected: ${JSON.stringify(cycles)}. Please retry without creating cycles.`;
                    console.log(errorInfo);

                    // Update log with error
                    await updateQualiaOperationLog(currentLogRef, { error: errorInfo });

                    continue;
                }

                // Success
                qualiaDoc = newDoc;
                break;

            } catch (e) {
                // Base graph corruption - fail permanently
                if (e instanceof BaseGraphCorruptionError) {
                    console.error("Base graph corruption during compaction:", e.message);
                    if (currentLogRef) {
                        await updateQualiaOperationLog(currentLogRef, { error: `Base graph corruption: ${e.message}` });
                    }
                    throw e;
                }
                // Operation validation errors - retry with context
                if (e instanceof GraphValidationError) {
                    errorInfo = e.message;
                    console.log(errorInfo);
                    if (currentLogRef) {
                        await updateQualiaOperationLog(currentLogRef, { error: errorInfo });
                    }
                    continue;
                }
                // Other errors
                if (currentLogRef) {
                    await updateQualiaOperationLog(currentLogRef, { error: `Unknown error: ${e}` });
                }
                throw e;
            }
        }

        // Record step
        if (currentLogRef) {
            executedSteps.push({ logRef: currentLogRef });
        }

        // Track integrated communications
        for (const comm of currentPending) {
            if (comm.id) {
                integratedCommunicationIds.add(comm.id);
                allIntegratedCommunications.push(comm);
            }
        }

        qualiaSizePercent = await getMaxQualiaSizePercent(qualiaDoc);
    }

    const qualiaDocsColl = await qualiaDocsCollection();
    const newDocRef = doc(qualiaDocsColl);
    const newQualiaDocRef = newDocRef;

    const newDocData = {
        ...qualiaDoc,
        nextQualiaDocId: "",
        createdTime: Timestamp.now()
    };

    console.log(`New qualia doc created: ${newQualiaDocRef.id}`);

    // Verify lock ownership before committing
    // Lock is now on Qualia doc
    const qualiaRef = doc(await qualiaCollection(), qualiaDoc.qualiaId);
    await runTransactionWithLockVerification(db, qualiaRef, lockOwnerId, async (transaction) => {
        transaction.set(newDocRef, newDocData);
        transaction.update(qualiaRef, { currentQualiaDocId: newQualiaDocRef.id, processingBefore: null });

        // Update all executed steps with the new qualiaDocId
        for (const step of executedSteps) {
            transaction.update(step.logRef, { newQualiaDocId: newQualiaDocRef.id });
        }

        // Ack all integrated communications
        const commsColl = await communicationsCollection();
        for (const comm of allIntegratedCommunications) {
            if (comm.id) {
                transaction.update(doc(commsColl, comm.id), { ack: true });
            }
        }
    });

    return newQualiaDocRef;
}

async function qualiaCompaction(qualiaDocRef: DocumentReference): Promise<DocumentReference> {
    const qualiaDocSnap = await getDoc(qualiaDocRef);
    if (!qualiaDocSnap.exists()) throw new Error("Qualia doc does not exist");
    const qualiaDoc = qualiaDocSnap.data() as QualiaDoc;
    const qualiaRef = doc(await qualiaCollection(), qualiaDoc.qualiaId);

    let timeToWait = 0;

    // Lock Qualia doc
    const result = await runWithLock(
        qualiaRef,
        async (lockOwnerId) => {
            try {
                // Re-fetch qualia doc inside lock to ensure we have latest
                // Actually performCompaction fetches it again or we pass it?
                // performCompaction takes qualiaDocRef.
                // If we are locked, nobody else should be changing the current doc ID?
                // But wait, if someone else finished compaction just before we got lock, 
                // the current doc ID might have changed.
                // We should check if qualiaDocRef is still the current one?

                const currentQualiaDocRef = await getQualiaDoc(qualiaDoc.qualiaId);
                if (currentQualiaDocRef.id !== qualiaDocRef.id) {
                    console.log(`Qualia doc changed during lock acquisition. Returning new doc.`);
                    return currentQualiaDocRef;
                }

                const newQualiaDocRef = await performCompaction(qualiaDocRef, lockOwnerId);
                console.log(`Compaction complete. Existing doc ${qualiaDocRef.id} updated with new content.`);
                return newQualiaDocRef;
            } catch (error) {
                console.error(`Error during qualia compaction: ${qualiaDocRef.id} : ${error}`);
                throw error;
            }
        },
        COMPACTION_PROCESSING_SECONDS,
        (data) => {
            // Check if currentQualiaDocId has changed?
            // If data (Qualia) has currentQualiaDocId different from what we expect?
            // We don't have expected ID here easily without reading it.
            // But runWithLock checkFn receives Qualia data.
            // If we want to ensure we are compacting the *latest*, we should check.
            // But getQualiaDoc already gave us what it thought was latest.
            return true;
        }
    );

    if (result) return result;

    // Could not claim lock.
    const qualiaSnap = await getDoc(qualiaRef);
    const qualiaData = qualiaSnap.data() as Qualia;

    if (qualiaData.currentQualiaDocId && qualiaData.currentQualiaDocId !== qualiaDocRef.id) {
        return doc(await qualiaDocsCollection(), qualiaData.currentQualiaDocId);
    }

    if (qualiaData.processingBefore) {
        timeToWait = getTimeToWait(qualiaData.processingBefore.toMillis(), MAX_COMPACTION_PROCESSING_SECONDS);
        if (timeToWait > 0) {
            console.log(`Another client is compacting/integrating ${qualiaDoc.qualiaId}, waiting for ${timeToWait}ms`);
            await waitForLockRelease(qualiaRef, timeToWait);
            return qualiaCompaction(qualiaDocRef);
        }
    }

    return qualiaCompaction(qualiaDocRef);
}

/*
    Merges the new names with the existing ones.
*/
export async function updateContacts(contacts: Contact[], transaction: Transaction): Promise<void> {
    console.log(`Updating contacts: ${JSON.stringify(contacts)}`);
    const q = query(
        await contactsCollection(),
        where("qualiaId", "==", await getUserId())
    );

    // We query outside the transaction to get the doc ref
    const snapshot = await getDocs(q);
    const docs = snapshot.docs;

    if (docs.length === 0) {
        const newDocRef = doc(await contactsCollection());
        transaction.set(newDocRef, {
            qualiaId: await getUserId(),
            qualiaContacts: contacts,
        });
    } else if (docs.length === 1) {
        const docRef = docs[0].ref;
        // Re-read inside transaction for lock and consistency
        const docSnap = await transaction.get(docRef);
        if (!docSnap.exists()) throw new Error("Contacts doc missing during transaction");

        const existingContacts = docSnap.data() as Contacts;
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

        transaction.update(docRef, { qualiaContacts: mergedContacts });
        console.log(`Contacts updated successfully`);
    } else {
        console.error("Duplicate contacts found");
        throw new Error("Duplicate contacts found");
    }
}

const messageBatchProcessor = new BatchProcessor<Communication>(
    new RateLimiter(60, "MessageBatcher"),
    async (batch) => {
        if (batch.length === 0) return;
        console.log(`Processing batch of ${batch.length} messages`);

        // Group messages by Qualia to handle them in context
        const messagesByQualia = new Map<string, Communication[]>();
        for (const comm of batch) {
            const qualiaId = comm.toQualiaId;
            if (!qualiaId) continue;
            if (!messagesByQualia.has(qualiaId)) {
                messagesByQualia.set(qualiaId, []);
            }
            messagesByQualia.get(qualiaId)!.push(comm);
        }

        for (const [qualiaId, communications] of messagesByQualia) {
            try {
                // Trigger compaction if needed
                await getQualiaDocRef(qualiaId);
                const qualiaRef = doc(await qualiaCollection(), qualiaId);

                console.log(`Processing message batch for qualia ${qualiaId}`);

                // Fetch fresh data for context
                const qualiaDocRef = await getQualiaDoc(qualiaId);
                const docSnap = await getDoc(qualiaDocRef);
                const qualiaDoc = docSnap.data() as QualiaDoc;
                const qualia = await getQualia(qualiaId);

                // Generate response for the batch
                // 1. Prepare contact updates (incoming)
                const incomingContacts: Contact[] = [];
                for (const comm of communications) {
                    if (comm.fromQualiaId) {
                        incomingContacts.push({
                            names: comm.fromQualiaName ? [comm.fromQualiaName] : [],
                            qualiaId: comm.fromQualiaId,
                            lastContactTime: Timestamp.now()
                        });
                    }
                }

                // 2. Generate response
                const response = await getResponseCommunications(qualiaDoc, qualia, communications);
                const validCommunications: Communication[] = [];
                if (response.communications.length > 0) {
                    for (const comm of response.communications) {
                        validCommunications.push(await getValidCommunication(comm));
                    }
                } else {
                    console.log(`No new communications generated for batch.`);
                }

                // 3. Prepare contact updates (outgoing)
                const outgoingContacts: Contact[] = [];
                for (const comm of response.communications) {
                    if (comm.toQualiaName && comm.toQualiaId) {
                        outgoingContacts.push({
                            names: [comm.toQualiaName],
                            qualiaId: comm.toQualiaId,
                            lastContactTime: Timestamp.now(),
                        });
                    }
                }

                const allContactsToUpdate = [...incomingContacts, ...outgoingContacts];

                // 4. Atomic Commit
                await runTransaction(db, async (transaction) => {
                    // Update contacts
                    if (allContactsToUpdate.length > 0) {
                        await updateContacts(allContactsToUpdate, transaction);
                    }

                    // Mark incoming as received
                    const commsColl = await communicationsCollection();
                    for (const comm of communications) {
                        if (comm.id) {
                            transaction.update(doc(commsColl, comm.id), { receivedTime: Timestamp.now() });
                        }
                    }

                    // Create outgoing messages
                    for (const comm of validCommunications) {
                        const newCommRef = doc(commsColl);
                        transaction.set(newCommRef, comm);
                    }
                });

                // Trigger integration (outside transaction, it's just a signal)
                triggerIntegration(qualiaId);

            } catch (e) {
                console.error(`Error processing message batch for qualia ${qualiaId}:`, e);
            }
        }
    },
    "MessageBatchProcessor"
);

async function messageHandler(communication: Communication): Promise<void> {
    // Filter out QUALIA_TO_HUMAN messages if they somehow got here (though toQualiaId check usually prevents this)
    if (communication.communicationType === "QUALIA_TO_HUMAN") {
        console.log(`Skipping QUALIA_TO_HUMAN message: ${communication.id}`);
        return;
    }

    // Filter out self-sent QUALIA_TO_QUALIA messages to prevent loops
    // We allow HUMAN_TO_QUALIA from self (which share the same ID)
    if (communication.communicationType === "QUALIA_TO_QUALIA" && communication.fromQualiaId === await getUserId()) {
        console.log(`Skipping self-sent QUALIA_TO_QUALIA message: ${communication.id}`);
        return;
    }

    console.log(`Queueing message for batch processing: ${communication.id}`);
    messageBatchProcessor.add(communication);
}

const integrationBatchProcessor = new BatchProcessor<string>(
    new RateLimiter(60, "IntegrationBatcher"),
    async (batch) => {
        if (batch.length === 0) return;
        console.log(`Processing integration batch of ${batch.length} triggers`);

        // Deduplicate qualiaIds
        const uniqueQualiaIds = Array.from(new Set(batch));
        console.log(`Unique qualiaIds in batch: ${uniqueQualiaIds.join(", ")}`);

        // Process integrations concurrently (RateLimiter inside attemptIntegration/integrateCommunications will handle throttling)
        await Promise.all(uniqueQualiaIds.map(async (qualiaId) => {
            try {
                // Trigger compaction if needed
                await getQualiaDocRef(qualiaId);
                await attemptIntegration(qualiaId);
            } catch (e) {
                console.error(`Error in triggered integration for ${qualiaId}:`, e);
            }
        }));
    },
    "IntegrationBatchProcessor"
);

async function triggerIntegration(qualiaId: string) {
    console.log(`Triggering integration for ${qualiaId}`);
    integrationBatchProcessor.add(qualiaId);
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

async function logQualiaOperation(qualiaId: string, operations: IntegrationOperation[], communicationIds: string[], oldQualiaDocId: string, newQualiaDocId?: string, error?: string, reasoning?: string): Promise<DocumentReference> {
    return await addDoc(await qualiaDocOperationsCollection(), {
        qualiaId,
        oldQualiaDocId: oldQualiaDocId,
        newQualiaDocId: newQualiaDocId || "",
        operations,
        communicationIds,
        error: error || "",
        reasoning: reasoning || "",
        createdTime: Timestamp.now()
    });
}

async function updateQualiaOperationLog(logRef: DocumentReference, updates: { oldQualiaDocId?: string, newQualiaDocId?: string, error?: string }) {
    await updateDoc(logRef, updates);
}

async function validateSizeReduction(oldDoc: QualiaDoc, newDoc: QualiaDoc, currentLogRef: DocumentReference) {
    const oldNodeCount = Object.keys(oldDoc.nodes || {}).length;
    const newNodeCount = Object.keys(newDoc.nodes || {}).length;

    // Only check if we have a meaningful amount of nodes to start with (e.g., > 10)
    if (oldNodeCount > 10 && newNodeCount < oldNodeCount * 0.5) {
        const errorMessage = `CRITICAL: Operation aborted. Significant size reduction detected (Old: ${oldNodeCount}, New: ${newNodeCount}). Operation Log ID: ${currentLogRef.id}`;
        console.error(errorMessage);

        // Update log with error
        await updateQualiaOperationLog(currentLogRef, { error: errorMessage });

        throw new Error(errorMessage);
    }
}

async function attemptIntegration(qualiaId: string) {
    console.log("Attempting integration");

    const qualiaRef = doc(await qualiaCollection(), qualiaId);
    const result = await runWithLock(
        qualiaRef,
        async (lockOwnerId) => {
            console.log(`Integration started for qualia ${qualiaId}`);
            try {
                // Fetch fresh data
                // We need to get the CURRENT qualia doc.
                const qualiaDocRef = await getQualiaDoc(qualiaId);
                const docSnap = await getDoc(qualiaDocRef);

                if (!docSnap.exists()) {
                    console.log(`Qualia doc ${qualiaDocRef.id} does not exist. Skipping.`);
                    return;
                }
                let qualiaDoc = docSnap.data() as QualiaDoc;

                if (qualiaDoc.nextQualiaDocId) {
                    console.log(`Qualia doc ${qualiaDocRef.id} already integrated. Skipping.`);
                    return;
                }

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
                let currentLogRef: DocumentReference | undefined;

                while (true) {
                    try {
                        const integrationResult = await integrateCommunications(qualiaDoc, pendingCommunications, errorInfo);
                        lastOperations = integrationResult.operations;

                        // Log operations immediately
                        currentLogRef = await logQualiaOperation(
                            qualiaId,
                            lastOperations,
                            pendingCommunications.map(c => c.id).filter((id): id is string => !!id),
                            qualiaDocRef.id, // oldQualiaDocId
                            undefined, // newQualiaDocId: New doc not created yet, will be updated later
                            undefined, // error: No error yet
                            integrationResult.reasoning
                        );

                        newDoc = applyOperations(qualiaDoc, integrationResult.operations);

                        // Safety Check: Prevent significant size reduction (> 50%)
                        await validateSizeReduction(qualiaDoc, newDoc, currentLogRef);

                        const cycles = detectCycles(newDoc);
                        if (cycles) {
                            errorInfo = `Cycle detected: ${JSON.stringify(cycles)}. Please retry without creating cycles.`;
                            if (lastOperations) {
                                errorInfo += `\nAttempted operations: ${JSON.stringify(lastOperations)}`;
                            }
                            console.log(errorInfo);

                            // Update log with error
                            await updateQualiaOperationLog(currentLogRef, { error: errorInfo });

                            continue;
                        }

                        // Success
                        break;
                    } catch (e) {
                        // Base graph corruption - fail permanently, don't retry
                        if (e instanceof BaseGraphCorruptionError) {
                            console.error("Base graph corruption detected:", e.message);
                            if (currentLogRef) {
                                await updateQualiaOperationLog(currentLogRef, { error: `Base graph corruption: ${e.message}` });
                            }
                            throw e; // Propagate to caller/UI
                        }
                        // Operation validation errors - retry with context
                        if (e instanceof GraphValidationError) {
                            errorInfo = e.message;
                            console.log(errorInfo);
                            if (currentLogRef) {
                                await updateQualiaOperationLog(currentLogRef, { error: errorInfo });
                            }
                            continue;
                        }
                        // Other errors
                        if (currentLogRef) {
                            // Avoid re-logging errors that were already handled and logged by validateSizeReduction
                            if (e instanceof Error && e.message.startsWith("CRITICAL")) {
                                // Already logged
                            } else {
                                await updateQualiaOperationLog(currentLogRef, { error: `Unknown error: ${e}` });
                            }
                        }
                        throw e;
                    }
                }

                let newQualiaDocRef: DocumentReference;
                const commsColl = await communicationsCollection();

                if (lastOperations && lastOperations.length > 0) {
                    // Success. Create new doc and link from old.
                    const qualiaDocsColl = await qualiaDocsCollection();
                    const newDocRef = doc(qualiaDocsColl);
                    newQualiaDocRef = newDocRef;

                    const newDocData = {
                        ...newDoc!,
                        nextQualiaDocId: "",
                        processingBefore: null,
                        createdTime: Timestamp.now()
                    };

                    // Verify lock ownership before committing
                    const qualiaRef = doc(await qualiaCollection(), qualiaId);
                    await runTransactionWithLockVerification(db, qualiaRef, lockOwnerId, async (transaction) => {
                        transaction.set(newDocRef, newDocData);
                        transaction.update(qualiaDocRef, {
                            nextQualiaDocId: newQualiaDocRef.id,
                        });
                        // Update Qualia doc with new ID
                        transaction.update(qualiaRef, { currentQualiaDocId: newQualiaDocRef.id });

                        // Update the successful log with the new qualiaDocId
                        if (currentLogRef) {
                            transaction.update(currentLogRef, { newQualiaDocId: newQualiaDocRef.id });
                        }

                        // Mark communications as acked
                        for (const comm of pendingCommunications) {
                            if (comm.id) {
                                transaction.update(doc(commsColl, comm.id), { ack: true });
                            }
                        }
                    });

                    console.log(`Created new qualia doc: ${newQualiaDocRef.id} from integration`);
                } else {
                    console.log("No operations generated. Skipping new doc creation.");
                    newQualiaDocRef = qualiaDocRef;

                    // Atomic update for log and acks
                    const qualiaRef = doc(await qualiaCollection(), qualiaId);
                    await runTransactionWithLockVerification(db, qualiaRef, lockOwnerId, async (transaction) => {
                        if (currentLogRef) {
                            transaction.update(currentLogRef, { newQualiaDocId: newQualiaDocRef.id });
                        }
                        // Ack communications
                        for (const comm of pendingCommunications) {
                            if (comm.id) {
                                transaction.update(doc(commsColl, comm.id), { ack: true });
                            }
                        }
                    });
                }

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

export async function getQualiaDocRef(qualiaId: string) {
    let qualiaDocRef = await getQualiaDoc(qualiaId);
    const qualiaDoc = (await getDoc(qualiaDocRef)).data() as QualiaDoc;
    if (await getMaxQualiaSizePercent(qualiaDoc) > 98) {
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
    const qualiaRef = doc(await qualiaCollection(), qualiaId);
    const qualiaSnap = await getDoc(qualiaRef);

    if (qualiaSnap.exists()) {
        const qualia = qualiaSnap.data() as Qualia;
        if (qualia.currentQualiaDocId) {
            return doc(await qualiaDocsCollection(), qualia.currentQualiaDocId);
        }
    }

    // Fallback to query if currentQualiaDocId is missing (lazy migration)
    const q = query(
        await qualiaDocsCollection(),
        where("qualiaId", "==", qualiaId),
        where("nextQualiaDocId", "==", "")
    );
    let snapshot = await getDocs(q);
    if (snapshot.docs.length > 1) {
        console.warn("Multiple qualia docs found in cache, falling back to server...");
        snapshot = await getDocsFromServer(q);
    }
    const docs = snapshot.docs;

    if (docs.length === 0) {
        // Create initial qualia doc
        const initialQualiaDoc: QualiaDoc = { qualiaId: qualiaId, nodes: {}, nextQualiaDocId: "", createdTime: Timestamp.now() };
        const newDocRef = await addDoc(await qualiaDocsCollection(), initialQualiaDoc);

        // Update Qualia doc with the new ID
        await updateDoc(qualiaRef, { currentQualiaDocId: newDocRef.id });
        return newDocRef;
    }

    if (docs.length > 1) {
        const v = docs.map(d => ({ id: d.id, size: Object.keys(d.data()).length, createdTime: d.data().createdTime.toDate(), nextQualiaDocId: d.data().nextQualiaDocId })).map(x => JSON.stringify(x)).join(", ");
        throw new Error(`Unique qualia doc not found: ${v}`);
    }

    // Found exactly one doc, update Qualia doc with its ID (lazy migration)
    await updateDoc(qualiaRef, { currentQualiaDocId: docs[0].id });
    return docs[0].ref;
}


export function summarizeQualiaDoc(qualiaDoc: QualiaDoc): string {
    return Object.values(serializeQualia(qualiaDoc).qualia).map(x => x.conclusion).join("\n");
}

export async function summarizeConversations(conversations: Communication[], qualiaDocSummary: string): Promise<string> {
    if (conversations.length === 0) return "";
    const serializedConversations = JSON.stringify(conversations);
    const prompt = `Organize the following recent conversations in extreme detail. Highlight the key topics discussed and the user's sentiment. Use the provided Qualia for context:\n\nQualia:\n${qualiaDocSummary}\n\nConversations:\n${serializedConversations}`;
    console.log("Awaiting summarizer rate limiter...");
    await summarizerRateLimiter.acquire();
    const result = await summarizerModel.generateContent(prompt);
    const response = parseJson(result.response.text());
    return response.summary;
}

export async function summarizeOperations(operations: IntegrationOperation[], qualiaDocSummary: string): Promise<string> {
    if (operations.length === 0) return "";
    const serializedOperations = JSON.stringify(operations);
    const prompt = `Organize the following changes to the knowledge graph as extremely detailed subconscious thoughts and realizations. Do not leave out ANY details. It should sound like an internal monologue. Use the provided Qualia for context:\n\nQualia:\n${qualiaDocSummary}\n\nChanges:\n${serializedOperations}`;
    console.log("Awaiting summarizer rate limiter...");
    await summarizerRateLimiter.acquire();
    const result = await summarizerModel.generateContent(prompt);
    const response = parseJson(result.response.text());
    return response.summary;
}
