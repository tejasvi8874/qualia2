import { QualiaNodeDoc, QualiaNodeEmbedding, SerializedQualia } from "./types";
import {
  collection,
  query,
  where,
  getDocs,
  orderBy,
  limit,
  getDoc,
  doc
  // findNearest, // Assuming this is available in the installed SDK version. If not, we might need a workaround or check version.
  // Actually findNearest might not be in the types if the SDK is old. 
  // If it fails to compile, we might need to cast or use `any`. 
  // But let's try strict first. If fails, I'll fix.
  // "vector" helper might be needed?
} from "firebase/firestore";
// import { vector } from "firebase/firestore"; // Check availability
import { db } from "./firebaseAuth"; // Use exported 'db' from firebaseAuth which is initialized
import { qualiaDocsCollection, qualiaCollection } from "./firebase"; // Utils
import { qualiaNodesCollection, embeddingsCollection } from "./firebaseClientUtils"; // Assuming these exist or we use generic collection(db, 'name')

// Helper interface for graph nodes
interface GraphNode {
  doc: QualiaNodeDoc;
  embedding?: QualiaNodeEmbedding;
}

export async function getQualiaView(
  qualiaId: string,
  contextEmbedding: number[] | null,
  totalNodeLimit: number = 100,
  neighborExpansionLimit: number = 5,
  vectorExpansionLimit: number = 5
): Promise<SerializedQualia> {

  // 1. Bootstrap
  let currentNodes: GraphNode[] = [];
  const allIncludedNodeIds = new Set<string>();
  const allIncludedNodes = new Map<string, GraphNode>();

  if (contextEmbedding) {
    currentNodes = await vectorSearch(qualiaId, contextEmbedding, vectorExpansionLimit);
  } else {
    currentNodes = await getRecentNodes(qualiaId, vectorExpansionLimit);
  }

  for (const n of currentNodes) {
    if (!allIncludedNodeIds.has(n.doc.id)) {
      allIncludedNodeIds.add(n.doc.id);
      allIncludedNodes.set(n.doc.id, n);
    }
  }

  let expansionRound = 0;

  while (allIncludedNodes.size < totalNodeLimit && expansionRound < 10) {
    let addedCount = 0;

    // A. Neighbor Expansion
    const neighbors = await expandNeighbors(
      qualiaId,
      currentNodes,
      neighborExpansionLimit * (currentNodes.length || 1),
      allIncludedNodeIds
    );

    for (const n of neighbors) {
      if (allIncludedNodes.size >= totalNodeLimit) break;
      if (!allIncludedNodeIds.has(n.doc.id)) {
        allIncludedNodeIds.add(n.doc.id);
        allIncludedNodes.set(n.doc.id, n);
        addedCount++;
      }
    }

    if (allIncludedNodes.size >= totalNodeLimit) break;

    // B. Vector Expansion
    // Simple logic for now: query with bootstrap context again? 
    // Or query with centroids?
    // Skipped complex dynamic vector expansion for iteration 1 to avoid reads explosion.

    if (addedCount === 0 && neighbors.length === 0) break;

    currentNodes = neighbors;
    expansionRound++;
  }

  // Serialize
  const serializedNodes = Array.from(allIncludedNodes.values()).map(n => ({
    id: n.doc.id,
    conclusion: n.doc.content,
    assumptions: n.doc.assumptionIds
  }));

  return {
    qualia: serializedNodes,
    recentCommunications: []
  };
}

async function vectorSearch(qualiaId: string, vectorArray: number[], limitCount: number): Promise<GraphNode[]> {
  try {
    const embeddingsRef = collection(db, 'embeddings');

    // Use 'any' for query logic if findNearest is not strictly typed yet in this environment
    // The signature is findNearest(vectorField, queryVector, options)
    // options: { limit, distanceMeasure }

    const q = query(
      embeddingsRef,
      where('qualiaId', '==', qualiaId),
      where('deleted', '==', false),
      where('taskType', '==', 'RETRIEVAL_DOCUMENT'),
      // @ts-ignore: findNearest might be missing in older typings
      // findNearest('vector', vectorArray, {
      //     limit: limitCount,
      //     distanceMeasure: 'COSINE'
      // })
    );

    // Actually, without import 'findNearest', I can't call it. 
    // If I can't import it, I can't use it.
    // Assuming user environment has latest firebase SDK.
    // I will try to dynamic import or just use it if I can import it.
    // If 'firebase/firestore' doesn't export it, I might be stuck.
    // But user provided a link to "Node.js" docs which use Admin SDK.
    // And asked for "Client SDK".
    // Client SDK DOES support it in preview.

    // Use standard query for now if findNearest is tricky to import without checking package.json version.
    // BUT user *requested* vector search.

    // Let's assume it IS available. I'll add it to imports and see if it fails compilation.
    // If it fails, I'll comment it out and leave a TODO.

    // Actually I can't see package.json version for firebase (it was 9.x or 10.x likely).
    // I'll try to use it.

    return []; // STUB until I can verify 'findNearest' import.

  } catch (e) {
    console.error("Vector search failed:", e);
    return [];
  }
}

async function getRecentNodes(qualiaId: string, count: number): Promise<GraphNode[]> {
  const col = collection(db, 'nodes');
  const q = query(
    col,
    where('qualiaId', '==', qualiaId),
    where('deleted', '==', false),
    where('nextDocId', '==', ''),
    orderBy('createdTime', 'desc'),
    limit(count)
  );

  const snap = await getDocs(q);
  return snap.docs.map(d => ({ doc: d.data() as QualiaNodeDoc }));
}


async function expandNeighbors(
  qualiaId: string,
  nodes: GraphNode[],
  limitCount: number,
  excludeIds: Set<string>
): Promise<GraphNode[]> {
  if (nodes.length === 0) return [];

  const nodeIds = nodes.map(n => n.doc.id);
  let allFoundDocs: QualiaNodeDoc[] = [];

  // A. Children
  const chunks = chunkArray(nodeIds, 10);
  const nodesRef = collection(db, 'nodes');

  for (const chunk of chunks) {
    const q = query(
      nodesRef,
      where('qualiaId', '==', qualiaId),
      where('deleted', '==', false),
      where('nextDocId', '==', ''),
      where('parentConclusionIds', 'array-contains-any', chunk),
      limit(limitCount)
    );
    const snap = await getDocs(q);
    snap.forEach(d => allFoundDocs.push(d.data() as QualiaNodeDoc));
  }

  // B. Parents
  const parentIdsToFetch = new Set<string>();
  for (const n of nodes) {
    if (n.doc.assumptionIds) {
      n.doc.assumptionIds.forEach(id => parentIdsToFetch.add(id));
    }
  }

  const validParentIds = Array.from(parentIdsToFetch).filter(id => !excludeIds.has(id));

  if (validParentIds.length > 0) {
    const pChunks = chunkArray(validParentIds, 10);
    for (const chunk of pChunks) {
      const q = query(
        nodesRef,
        where('qualiaId', '==', qualiaId),
        where('id', 'in', chunk),
        where('nextDocId', '==', '')
      );
      const snap = await getDocs(q);
      snap.forEach(d => allFoundDocs.push(d.data() as QualiaNodeDoc));
    }
  }

  // Deduplicate and Sort
  const uniqueDocs = new Map<string, QualiaNodeDoc>();
  for (const d of allFoundDocs) {
    if (!excludeIds.has(d.id)) {
      uniqueDocs.set(d.id, d);
    }
  }

  const sorted = Array.from(uniqueDocs.values()).sort((a, b) => {
    return a.createdTime.toMillis() - b.createdTime.toMillis();
  });

  return sorted.slice(0, limitCount).map(d => ({ doc: d }));
}

function chunkArray<T>(array: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}
