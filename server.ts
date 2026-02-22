import {
    addDoc,
    setDoc,
    query,
    where,
    updateDoc,
    getDocs,
    Timestamp,
    DocumentReference,
    getDoc,
    runTransaction,
    and,
    doc,
    onSnapshot,
    or,
    Transaction,
    collection,
    writeBatch
} from "firebase/firestore";
import { getGenerativeModel, HarmBlockThreshold, HarmCategory, ObjectSchema, Schema } from "firebase/ai";
import { httpsCallable } from "firebase/functions";

import { Communications, Communication, Contact, Contacts, Qualia, IntegrationResponse, IntegrationOperation, INTEGRATION_SCHEMA, COMMUNICATION_SCHEMA, SerializedQualia, QualiaNodeDoc, GenerateEmbeddingsResponse } from "./types";
import { serializeQualia, applyOperations, detectCycles, GraphValidationError, BaseGraphCorruptionError } from "./graphUtils";
import { getQualiaView } from "./graphView";
import { communicationsCollection, contactsCollection, getMessageListener, getUserId, qualiaDocOperationsCollection, qualiaDocsCollection, qualiaCollection } from "./firebase";
import { getContacts, getQualia } from "./firebaseClientUtils";
import { ai, db, functions } from "./firebaseAuth";
import { RateLimiter, BatchProcessor } from "./requestUtils";
import { memoize, parseIsoDeliveryTime, constructSystemPrompt } from "./utils";
import { FUNCTION_NAMES } from "./functions/src/shared";

/*
Runs in background, handles all communications. Designed to run on device or in cloud.
*/

export async function messageListener() {
    return getMessageListener(await getUserId(), await communicationsCollection(), or(where("fromQualiaId", "!=", await getUserId()), where("communicationType", "in", ["HUMAN_TO_QUALIA", "QUALIA_TO_QUALIA", "HUMAN_TO_HUMAN"])), messageHandler, true, "seen");
}

const safetySettings = Object.values(HarmCategory).map((category) => ({ category, threshold: HarmBlockThreshold.BLOCK_NONE }));
const proModelName = "gemini-3-pro-preview";
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

// Cloud Function 
const generateEmbeddingsFunctions = httpsCallable(functions, FUNCTION_NAMES.GENERATE_EMBEDDINGS);
async function generateEmbeddings(contents: string[], taskType: "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT"): Promise<GenerateEmbeddingsResponse> {
    const result = await generateEmbeddingsFunctions({ contents, taskType });
    return result.data as GenerateEmbeddingsResponse;
}

function viewToTempDoc(view: SerializedQualia, qualiaId: string): QualiaDoc {
    const nodes: Record<string, any> = {};
    for (const n of view.qualia) {
        nodes[n.id] = {
            id: n.id,
            conclusion: n.conclusion,
            assumptionIds: n.assumptions || [],
            timestamp: Timestamp.now()
        };
    }
    return { qualiaId, nodes, nextQualiaDocId: "", createdTime: Timestamp.now() };
}

async function getContextEmbedding(communications: Communication[]): Promise<number[] | null> {
    if (communications.length === 0) return null;
    try {
        const texts = communications.slice(-5).map(c => c.message || "").filter(t => t.length > 0);
        if (texts.length === 0) return null;

        const response = await generateEmbeddings(texts, "RETRIEVAL_QUERY");
        if (response.embeddings.length === 0) return null;

        const dim = response.embeddings[0].values.length;
        const avg = new Array(dim).fill(0);
        for (const emb of response.embeddings) {
            for (let i = 0; i < dim; i++) {
                avg[i] += emb.values[i];
            }
        }
        for (let i = 0; i < dim; i++) {
            avg[i] /= response.embeddings.length;
        }
        return avg;

    } catch (e) {
        console.error("Failed to get context embedding", e);
        return null;
    }
}

async function runWithScopedLock<T>(
    qualiaId: string,
    scope: "integrationLock" | "responseLock",
    work: (lockId: string) => Promise<T>
): Promise<T | undefined> {
    const qualiaRef = doc(await qualiaCollection(), qualiaId);
    const lockDuration = 600;
    const myLockId = Math.random().toString(36).substring(2);

    try {
        await runTransaction(db, async t => {
            const q = await t.get(qualiaRef);
            if (!q.exists()) throw new Error("Qualia not found");
            const data = q.data() as Qualia;
            const lockState = data[scope];
            if (lockState && lockState.processingBefore && lockState.processingBefore.toMillis() > Date.now()) {
                throw new Error("Locked");
            }
            t.update(qualiaRef, {
                [scope]: {
                    processingBefore: Timestamp.fromMillis(Date.now() + lockDuration * 1000),
                    lockOwner: myLockId
                }
            });
        });
    } catch (e) {
        console.log(`Could not acquire ${scope} for ${qualiaId}: ${e}`);
        return undefined;
    }

    try {
        const res = await work(myLockId);
        await updateDoc(qualiaRef, { [scope]: { processingBefore: null, lockOwner: null } });
        return res;
    } catch (e) {
        await updateDoc(qualiaRef, { [scope]: { processingBefore: null, lockOwner: null } });
        throw e;
    }
}

async function getResponseCommunications(qualiaId: string, communications: Partial<Communication>[]): Promise<Communications> {
    console.log("Awaiting rate limiter...");
    await getResponseCommunicationsRateLimiter.acquire();

    return await runWithScopedLock(qualiaId, "responseLock", async () => {
        const pendingCommunications = await getPendingCommunications(qualiaId);
        const allContextComms = [...pendingCommunications, ...communications as Communication[]];
        const contextEmbedding = await getContextEmbedding(allContextComms);
        const qualiaView = await getQualiaView(qualiaId, contextEmbedding, 50);

        const pendingCommsSerialized = pendingCommunications.map(c => ({ ...c, createdTime: c.deliveryTime }));

        const prompt = `Generate new commmunications if required, keeping recent conversations in mind:

Current Qualia (Focus Area):
${JSON.stringify(qualiaView.qualia)}

Context:
${JSON.stringify({ myQualiaId: qualiaId, currentTimestamp: new Date().toString() })}

Previous Communications:
${JSON.stringify(pendingCommsSerialized)}

Recent Communications:
${JSON.stringify(communications)}`;

        console.log(`Calling Gemini with prompt: ${prompt.substring(0, 100)}...`);
        const result = await communicationModel.generateContent(prompt);
        const response = parseJson(result.response.text());
        console.log(`Received response from Gemini: ${JSON.stringify(response)}`);
        return response;
    }) || { communications: [] };
}

async function integrateCommunications(qualiaId: string, pendingCommunications: Communication[], errorInfo?: string): Promise<{ ops: IntegrationOperation[], view: SerializedQualia }> {
    const contextEmbedding = await getContextEmbedding(pendingCommunications);
    const qualiaView = await getQualiaView(qualiaId, contextEmbedding);
    const pendingCommsSerialized = pendingCommunications.map(c => ({ ...c, createdTime: c.deliveryTime }));

    let prompt = `Integrate recent communications into the qualia.
API Usage:
- To CREATE a new conclusion, specify a unique 'id' and 'newConclusion' text.
- To UPDATE an existing conclusion, specify its 'id' and provide 'newConclusion', 'addAssumptions', or 'removeAssumptions' as needed.
- To DELETE a conclusion, specify its 'id' and set 'newConclusion' to empty string ("").

Current Qualia (Focus Area):
${JSON.stringify(qualiaView.qualia)}

Recent Communications:
${JSON.stringify(pendingCommsSerialized)}`;

    if (errorInfo) {
        prompt += `\n\nPrevious integration attempt failed:\n\n${errorInfo}\n\nPlease resolve.`;
    }
    console.log("Awaiting integration rate limiter...");
    await integrationRateLimiter.acquire();
    const result = await integrationModel.generateContent(prompt);
    const response = parseJson(result.response.text());
    return { ops: response.operations, view: qualiaView };
}

async function logNodeOperation(
    qualiaId: string,
    operations: IntegrationOperation[],
    communicationIds: string[],
    nodeDocIdMap: Map<string, string>, // NodeID -> Latest DocID before transaction
    nodesToWrite: QualiaNodeDoc[], // New node docs to be written
    nodeIdsToDelete: string[], // Node IDs to be soft-deleted
    newDocRefs: Map<string, string>, // NodeID -> New Doc Ref ID (for new/updated nodes)
    deletedDocRefs: Map<string, string> // NodeID -> New Doc Ref ID (for deleted nodes)
) {
    const changedNodeDocIds: { nodeId: string, oldDocId?: string, newDocId?: string }[] = [];

    // For updated/new nodes
    for (const n of nodesToWrite) {
        const oldDocId = nodeDocIdMap.get(n.id);
        const newDocId = newDocRefs.get(n.id);
        changedNodeDocIds.push({ nodeId: n.id, oldDocId, newDocId });
    }

    // For deleted nodes
    for (const nodeId of nodeIdsToDelete) {
        const oldDocId = nodeDocIdMap.get(nodeId);
        const newDocId = deletedDocRefs.get(nodeId); // This will be the doc marking it as deleted
        changedNodeDocIds.push({ nodeId, oldDocId, newDocId });
    }

    await addDoc(await qualiaDocOperationsCollection(), {
        qualiaId,
        operations,
        communicationIds,
        changedNodeDocIds,
        createdTime: Timestamp.now()
    });
}

async function applyNodeOperations(
    qualiaId: string,
    operations: IntegrationOperation[],
    baseView: SerializedQualia,
    communicationIds: string[] // Added communicationIds parameter
): Promise<void> {
    const tempDoc = viewToTempDoc(baseView, qualiaId);
    const newTempDoc = applyOperations(tempDoc, operations); 

    // Cycle detection
    const cycles = detectCycles(newTempDoc);
    if (cycles) throw new Error(`Cycle detected: ${JSON.stringify(cycles)}`);

    const nodesToWrite: QualiaNodeDoc[] = [];
    const embeddingTasks: { content: string, nodeDocId: string, nodeId: string }[] = [];
    const oldIds = new Set(Object.keys(tempDoc.nodes));
    const newIds = new Set(Object.keys(newTempDoc.nodes));

    const nodeIdsToDelete: string[] = [];

    for (const id of oldIds) {
        if (!newIds.has(id)) nodeIdsToDelete.push(id);
    }

    for (const id of newIds) {
        const newNodeState = newTempDoc.nodes[id];
        const oldNodeState = tempDoc.nodes[id];
        const isNew = !oldNodeState;
        const isChanged = oldNodeState && (oldNodeState.conclusion !== newNodeState.conclusion || JSON.stringify(oldNodeState.assumptionIds) !== JSON.stringify(newNodeState.assumptionIds));

        if (isNew || isChanged) {
            // We generate a new doc ref ID here to use consistently
            const newDocRefId = doc(collection(db, 'nodes')).id;
            const nodeDoc: QualiaNodeDoc = {
                id: id,
                qualiaId: qualiaId,
                content: newNodeState.conclusion,
                assumptionIds: newNodeState.assumptionIds,
                nextDocId: "",
                previousDocId: "",
                deleted: false,
                createdTime: Timestamp.now()
            };
            nodesToWrite.push(nodeDoc);
            embeddingTasks.push({
                content: nodeDoc.content + (nodeDoc.assumptionIds.length > 0 ? " (Assumptions: " + nodeDoc.assumptionIds.join(" ") + ")" : ""),
                nodeDocId: newDocRefId, // Use the pre-generated ID
                nodeId: id
            });
        }
    }

    const qualiaRef = doc(await qualiaCollection(), qualiaId);

    // Simplified Write Strategy:
    // 1. Identify outdated docs
    // 2. Transact: Verify outdated docs are still latest, Mark them 'nextDocId', Write new docs, Update Qualia.currentQualiaNodeDocIds

    // We need to find the Doc IDs for the nodes we are modifying/deleting.
    // Query them first.
    // Nodes to find: nodeIdsToDelete + nodesToWrite.map(n => n.id) that are UPDATES.
    const nodesToFind = new Set([...nodeIdsToDelete]);
    nodesToWrite.forEach(n => {
        if (oldIds.has(n.id)) nodesToFind.add(n.id);
    });

    const nodeDocIdMap = new Map<string, string>(); // NodeID -> DocID (latest active doc before this transaction)
    const nodesRef = collection(db, 'nodes');

    // Batch queries
    const idsToQuery = Array.from(nodesToFind);
    const chunks = [];
    for (let i = 0; i < idsToQuery.length; i += 10) chunks.push(idsToQuery.slice(i, i + 10));

    for (const chunk of chunks) {
        const q = query(nodesRef, where('qualiaId', '==', qualiaId), where('id', 'in', chunk), where('nextDocId', '==', ''));
        const snap = await getDocs(q);
        snap.forEach(d => nodeDocIdMap.set(d.data().id, d.id));
    }

    const newDocRefs = new Map<string, string>(); // nodeId -> new docId for new/updated nodes
    const deletedDocRefs = new Map<string, string>(); // nodeId -> new docId for deleted nodes

    await runTransaction(db, async (transaction) => {
        const qualiaSnap = await transaction.get(qualiaRef);
        if (!qualiaSnap.exists()) throw new Error("Qualia missing");

        const nodesColl = collection(db, 'nodes');

        // 1. New Docs / Updated Docs
        for (const n of nodesToWrite) {
            const prevDocId = nodeDocIdMap.get(n.id) || "";
            n.previousDocId = prevDocId;

            const matchingTask = embeddingTasks.find(t => t.nodeId === n.id);
            const newRef = doc(nodesColl, matchingTask!.nodeDocId); // Use the pre-generated ID from embeddingTasks

            transaction.set(newRef, n);
            newDocRefs.set(n.id, newRef.id); // Store for logging

            // Update Previous Doc
            if (prevDocId) {
                transaction.update(doc(nodesColl, prevDocId), { nextDocId: newRef.id });
            }
        }

        // 2. Deletions (Soft Delete)
        for (const id of nodeIdsToDelete) {
            const docId = nodeDocIdMap.get(id);
            if (docId) {
                const newRef = doc(nodesColl);
                transaction.set(newRef, {
                    id, qualiaId, content: "", assumptionIds: [],
                    nextDocId: "", previousDocId: docId,
                    deleted: true, createdTime: Timestamp.now()
                });
                deletedDocRefs.set(id, newRef.id); // Store for logging
                transaction.update(doc(nodesColl, docId), { nextDocId: newRef.id });
            }
        }

        // 3. Update Qualia.currentQualiaNodeDocIds
        const currentIds = new Set(qualiaSnap.data().currentQualiaNodeDocIds || []);

        // Remove old doc IDs that are being superseded or deleted
        for (const [nodeId, docId] of nodeDocIdMap) {
            if (currentIds.has(docId)) currentIds.delete(docId);
        }

        // Add new doc IDs for active nodes
        nodesToWrite.forEach(n => {
            const newDocId = newDocRefs.get(n.id);
            if (newDocId) currentIds.add(newDocId);
        });
        // Deleted nodes are not considered "current active"

        transaction.update(qualiaRef, { currentQualiaNodeDocIds: Array.from(currentIds) });
    });

    // Log the operation after the transaction is complete
    await logNodeOperation(qualiaId, operations, communicationIds, nodeDocIdMap, nodesToWrite, nodeIdsToDelete, newDocRefs, deletedDocRefs);

    if (embeddingTasks.length > 0) processEmbeddingsAsync(qualiaId, embeddingTasks);
}

async function processEmbeddingsAsync(qualiaId: string, tasks: { content: string, nodeDocId: string, nodeId: string }[]) {
    try {
        const chunks: typeof tasks[] = [];
        let currentChunk: typeof tasks = [];
        let currentSize = 0;
        for (const t of tasks) {
            if (currentSize + t.content.length > 1000000) {
                chunks.push(currentChunk);
                currentChunk = [];
                currentSize = 0;
            }
            currentChunk.push(t);
            currentSize += t.content.length;
        }
        if (currentChunk.length > 0) chunks.push(currentChunk);

        const embeddingsColl = collection(db, 'embeddings');

        for (const chunk of chunks) {
            const resp = await generateEmbeddings(chunk.map(c => c.content), "RETRIEVAL_DOCUMENT");
            const batch = writeBatch(db);

            resp.embeddings.forEach((emb, i) => {
                const task = chunk[i];
                const ref = doc(embeddingsColl);
                batch.set(ref, {
                    qualiaId,
                    nodeId: task.nodeId,
                    nodeDocId: task.nodeDocId,
                    vector: emb.values,
                    taskType: "RETRIEVAL_DOCUMENT",
                    deleted: false,
                    createdTime: Timestamp.now()
                });
            });
            await batch.commit();
        }
    } catch (e) {
        console.error("Embedding generation failed", e);
    }
}

export async function attemptIntegration(qualiaId: string) {
    await runWithScopedLock(qualiaId, "integrationLock", async () => {
        const pending = await getPendingCommunications(qualiaId);
        // If we have pending items OR if we just want to compact?
        if (pending.length === 0) return;

        const { ops, view } = await integrateCommunications(qualiaId, pending);
        const communicationIds = pending.map(c => c.id).filter((id): id is string => id !== undefined);

        if (ops.length > 0) {
            await applyNodeOperations(qualiaId, ops, view, communicationIds); // Pass communicationIds

            // Ack
            const commsColl = await communicationsCollection();
            const batch = writeBatch(db);
            for (const c of pending) { if (c.id) batch.update(doc(commsColl, c.id), { ack: true }); }
            await batch.commit();
        }
    });
}


const messageBatchProcessor = new BatchProcessor<Communication>(
    new RateLimiter(60, "MessageBatcher"),
    async (batch) => {
        if (batch.length === 0) return;
        const messagesByQualia = new Map<string, Communication[]>();
        for (const comm of batch) {
            if (comm.toQualiaId) {
                if (!messagesByQualia.has(comm.toQualiaId)) messagesByQualia.set(comm.toQualiaId, []);
                messagesByQualia.get(comm.toQualiaId)!.push(comm);
            }
        }

        for (const [qualiaId, communications] of messagesByQualia) {
            try {
                // We don't need 'getQualiaDocRef' monolithic check anymore.
                // We assume integration loop handles integration.
                // Here we just respond.

                const response = await getResponseCommunications(qualiaId, communications);

                // Outgoing handling similar to before...
                const validCommunications: Communication[] = [];
                if (response.communications.length > 0) {
                    for (const comm of response.communications) {
                        validCommunications.push(await getValidCommunication(comm));
                    }
                }

                // Update Contacts & Send
                await runTransaction(db, async (transaction) => {
                    // Update contacts
                    const contactsToUpdate: Contact[] = [];
                    for (const c of communications) {
                        if (c.fromQualiaId && c.fromQualiaName) {
                            contactsToUpdate.push({ qualiaId: c.fromQualiaId, names: [c.fromQualiaName], lastContactTime: Timestamp.now() });
                        }
                    }
                    if (contactsToUpdate.length > 0) {
                        await updateContacts(contactsToUpdate, transaction);
                    }

                    const commsColl = await communicationsCollection();
                    for (const comm of communications) if (comm.id) transaction.update(doc(commsColl, comm.id), { receivedTime: Timestamp.now() });

                    for (const comm of validCommunications) {
                        const newCommRef = doc(commsColl);
                        transaction.set(newCommRef, comm);
                    }
                });

                triggerIntegration(qualiaId);

            } catch (e) {
                console.error(`Error processing message batch for qualia ${qualiaId}:`, e);
            }
        }
    },
    "MessageBatchProcessor"
);

async function messageHandler(communication: Communication): Promise<void> {
    if (communication.communicationType === "QUALIA_TO_HUMAN") return;
    if (communication.communicationType === "QUALIA_TO_QUALIA" && communication.fromQualiaId === await getUserId()) return;
    messageBatchProcessor.add(communication);
}

const integrationBatchProcessor = new BatchProcessor<string>(
    new RateLimiter(60, "IntegrationBatcher"),
    async (batch) => {
        if (batch.length === 0) return;
        const uniqueQualiaIds = Array.from(new Set(batch));
        await Promise.all(uniqueQualiaIds.map(async (qualiaId) => {
            try {
                await attemptIntegration(qualiaId);
            } catch (e) {
                console.error(`Error in triggered integration for ${qualiaId}:`, e);
            }
        }));
    },
    "IntegrationBatchProcessor"
);

async function triggerIntegration(qualiaId: string) {
    integrationBatchProcessor.add(qualiaId);
}

function startPendingCommunicationsListener(qualiaId: string) {
    communicationsCollection().then(collection => {
        const q = query(collection, where("toQualiaId", "==", qualiaId), where("ack", "==", false));
        onSnapshot(q, (snapshot) => {
            if (snapshot.docs.length > 0) triggerIntegration(qualiaId);
        });
    });
}

export async function startIntegrationLoop(qualiaId: string) {
    startPendingCommunicationsListener(qualiaId);
}

export async function getPendingCommunications(qualiaId: string): Promise<Communication[]> {
    const q = query(await communicationsCollection(), where("toQualiaId", "==", qualiaId), where("ack", "==", false));
    const snapshot = await getDocs(q);
    const communications: Communication[] = [];
    snapshot.forEach((doc) => communications.push({ id: doc.id, ...doc.data() } as Communication));
    return communications;
}

// Keeping validation helpers
async function getValidCommunication(communication: Communication): Promise<Communication> {
    if (communication.communicationType === "QUALIA_TO_HUMAN" && !communication.toQualiaId) communication.toQualiaId = await getUserId();
    if (communication.fromQualiaId === undefined) communication.fromQualiaId = await getUserId();
    communication.ack = false;
    communication.seen = false;
    communication.deliveryTime = Timestamp.now();
    return communication;
}

// Keeping UpdateContacts if needed, but omitted for brevity in this response unless crucial
// Assuming it exists or I should restore it.

export async function updateContacts(contacts: Contact[], transaction: Transaction): Promise<void> {
    const q = query(
        await contactsCollection(),
        where("qualiaId", "==", await getUserId())
    );
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
        const docSnap = await transaction.get(docRef);
        if (!docSnap.exists()) throw new Error("Contacts doc missing");

        const existingContacts = docSnap.data() as Contacts;
        const existingQualiaContacts = existingContacts.qualiaContacts || [];

        const qualiaIdMap = new Map<string, Contact>();
        for (const contact of existingQualiaContacts) qualiaIdMap.set(contact.qualiaId, contact);
        for (const contact of contacts) {
            if (qualiaIdMap.has(contact.qualiaId)) {
                const newContact = qualiaIdMap.get(contact.qualiaId)!;
                newContact.names.push(...contact.names);
                newContact.lastContactTime = contact.lastContactTime;
                qualiaIdMap.set(contact.qualiaId, newContact);
            } else {
                qualiaIdMap.set(contact.qualiaId, contact);
            }
        }
        for (const [qualiaId, contact] of qualiaIdMap) {
            contact.names = Array.from(new Set(contact.names));
            qualiaIdMap.set(qualiaId, contact);
        }
        transaction.update(docRef, { qualiaContacts: Array.from(qualiaIdMap.values()) });
    }
}
