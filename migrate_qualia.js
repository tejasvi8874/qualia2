/*
  Migration script to convert monolithic QualiaDocs into individual QualiaNodeDocs.
  Also generates Vertex AI embeddings for each node.
  
  Run this script with:
  node migrate_qualia.js
*/

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { GoogleAuth } = require('google-auth-library');

try {
  initializeApp();
} catch (e) {
  // Ignore
}
const db = getFirestore();

// Initialize Vertex AI Auth
const auth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform']
});
const PROJECT_ID = 'tstomar-experimental'; // Replace if different
const LOCATION = 'us-central1';
const MODEL_ID = 'text-embedding-004';

// Limit batching to stay under 20k token limit for text-embedding-004
const MAX_EMBEDDING_BATCH_SIZE = 50;

async function generateEmbeddings(contents, taskType = "RETRIEVAL_DOCUMENT") {
  if (!contents || contents.length === 0) return { embeddings: [] };

  // According to vertex AI docs, we can batch embed contents
  // Using the REST API natively instead of SDK
  const client = await auth.getClient();
  const projectId = await auth.getProjectId() || PROJECT_ID;
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${MODEL_ID}:predict`;

  const payload = {
    instances: contents.map(text => ({
      content: text,
      taskType: taskType
    }))
  };

  const res = await client.request({
    url,
    method: 'POST',
    data: payload
  });

  // REST API returns predictions array. 
  // Format: { predictions: [ { embeddings: { values: [0.1, ...], statistics: {} } } ] }
  if (!res.data || !res.data.predictions) {
    throw new Error("Failed to get predictions from Vertex AI API: " + JSON.stringify(res.data));
  }

  return { embeddings: res.data.predictions.map(p => ({ values: p.embeddings.values })) };
}

async function migrateQualia(qualiaId = '1MM1DDZnDmXnn0GBB4oBGoRqKaD2') {
  console.log(`Starting migration for Qualia ID: ${qualiaId}`);

  // 1. Get the latest active QualiaDoc
  const qualiaDocsSnapshot = await db.collection('qualiaDocs')
    .where('qualiaId', '==', qualiaId)
    .where('nextQualiaDocId', '==', '')
    .limit(1)
    .get();

  if (qualiaDocsSnapshot.empty) {
    console.log(`No active QualiaDoc found for ${qualiaId}. It might already be migrated or empty.`);
    return;
  }

  const monolithicDoc = qualiaDocsSnapshot.docs[0];
  const monolithicData = monolithicDoc.data();
  const nodes = monolithicData.nodes || {};
  const nodeIds = Object.keys(nodes);

  console.log(`Found active monolithic QualiaDoc (${monolithicDoc.id}) with ${nodeIds.length} nodes.`);

  if (nodeIds.length === 0) {
    console.log("No nodes to migrate.");
    return;
  }

  // 2. Prepare nodes and tasks for embeddings
  const nodesToWrite = [];
  const embeddingTasks = [];

  for (const id of nodeIds) {
    const node = nodes[id];
    const contentStr = node.conclusion + (node.assumptionIds?.length > 0 ? " (Assumptions: " + node.assumptionIds.join(" ") + ")" : "");

    // Pre-generate a new Doc ID for the nodes collection
    const newDocRef = db.collection('nodes').doc();

    nodesToWrite.push({
      id: id,
      qualiaId: qualiaId,
      content: node.conclusion || "",
      assumptionIds: node.assumptionIds || [],
      nextDocId: "",         // this is the active document now
      previousDocId: "",     // migration origin
      deleted: false,
      createdTime: Timestamp.now(),
      ref: newDocRef // Store ref to use below
    });

    embeddingTasks.push({
      content: contentStr,
      nodeDocId: newDocRef.id,
      nodeId: id
    });
  }

  console.log(`Prepared ${nodesToWrite.length} discrete QualiaNodeDocs. Beginning transaction...`);

  // 3. Batch write the individual nodes and update currentQualiaNodeDocIds
  const rootQualiaRef = db.collection('qualia').doc(qualiaId);

  // We might need to split this if nodesToWrite > 500 (Firestore transaction limit)
  // Assuming mostly it's < 500 nodes for now. If > 500, we'll need batching.
  if (nodesToWrite.length > 400) {
    console.warn(`WARNING: Node count (${nodesToWrite.length}) is close to Firestore's transaction limit. Proceeding anyway, but split batching may be needed if this fails.`);
  }

  const currentQualiaNodeDocIds = [];

  await db.runTransaction(async (transaction) => {
    // Read root Qualia doc to ensure it exists
    const qualiaSnap = await transaction.get(rootQualiaRef);
    if (!qualiaSnap.exists) {
      throw new Error(`Root Qualia document missing for ID ${qualiaId}`);
    }

    // Set the individual node docs
    for (const n of nodesToWrite) {
      transaction.set(n.ref, {
        id: n.id,
        qualiaId: n.qualiaId,
        content: n.content,
        assumptionIds: n.assumptionIds,
        nextDocId: n.nextDocId,
        previousDocId: n.previousDocId,
        deleted: n.deleted,
        createdTime: n.createdTime
      });
      currentQualiaNodeDocIds.push(n.ref.id);
    }

    // Update the root document's current version pointers
    transaction.update(rootQualiaRef, {
      currentQualiaNodeDocIds: currentQualiaNodeDocIds
    });

    // Optional: you can mark the monolithic doc as 'migrated' to prevent accidental re-runs
    transaction.update(monolithicDoc.ref, { nextQualiaDocId: 'MIGRATED' });
  });

  console.log(`Transaction complete. Replaced monolithic graph with ${currentQualiaNodeDocIds.length} atomic distributed nodes.`);
  console.log(`Initiating vector embedding generation via Vertex AI...`);

  // 4. Generate & Save Embeddings
  // Batch process to prevent API limits
  const embeddingsColl = db.collection('embeddings');

  for (let i = 0; i < embeddingTasks.length; i += MAX_EMBEDDING_BATCH_SIZE) {
    const chunk = embeddingTasks.slice(i, i + MAX_EMBEDDING_BATCH_SIZE);
    console.log(`Generating embeddings for nodes ${i + 1} to ${i + chunk.length}...`);

    try {
      const resp = await generateEmbeddings(chunk.map(c => c.content));

      // Firebase Batch limit is 500 write operations
      const batch = db.batch();

      resp.embeddings.forEach((emb, idx) => {
        const task = chunk[idx];
        const ref = embeddingsColl.doc();
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
      console.log(`Successfully committed embeddings chunk.`);
    } catch (e) {
      console.error(`Error generating embeddings for chunk (starting at index ${i}):`, e);
    }
  }

  console.log("Migration complete!");
}

async function run() {
  try {
      const targetId = process.argv[2] || '1MM1DDZnDmXnn0GBB4oBGoRqKaD2';
      await migrateQualia(targetId);
    } catch (e) {
      console.error("Migration failed:", e);
    }
}

run();
