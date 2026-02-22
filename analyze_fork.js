
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

try {
  initializeApp();
} catch (e) {
  // Ignore
}
const db = getFirestore();

const TARGET_QUALIA_ID = '1MM1DDZnDmXnn0GBB4oBGoRqKaD2';

function calculateNodeDiff(nodes1 = {}, nodes2 = {}) {
  const ids1 = new Set(Object.keys(nodes1 || {}));
  const ids2 = new Set(Object.keys(nodes2 || {}));

  const addedIds = [...ids2].filter(id => !ids1.has(id));
  const removedIds = [...ids1].filter(id => !ids2.has(id));
  const commonIds = [...ids1].filter(id => ids2.has(id));

  const modifiedIds = commonIds.filter(id => {
    const n1 = nodes1[id];
    const n2 = nodes2[id];
    return JSON.stringify(n1) !== JSON.stringify(n2);
  });

  return { addedIds, removedIds, modifiedIds };
}

async function analyzeFork() {
  console.log(`Analyzing fork for Qualia ID: ${TARGET_QUALIA_ID}`);

  const snapshot = await db.collection('qualiaDocs')
    .where('qualiaId', '==', TARGET_QUALIA_ID)
    .get();

  if (snapshot.empty) {
    console.log('No documents found.');
    return;
  }

  const docs = snapshot.docs.map(doc => ({
    id: doc.id,
    data: doc.data(),
    createTime: doc.createTime.toDate()
  }));

  console.log(`Fetched ${docs.length} documents.`);

  // Map: ID -> Doc
  const docMap = new Map(docs.map(d => [d.id, d]));

  // Build Parent Map (ChildID -> ParentDoc)
  const childToParent = new Map();

  docs.forEach(parentDoc => {
    const nextId = parentDoc.data.nextQualiaDocId;
    if (nextId) {
      if (childToParent.has(nextId)) {
        console.warn(`WARNING: Child ${nextId} has MULTIPLE parents! (Merge or Collision)`);
      }
      childToParent.set(nextId, parentDoc);
    }
  });

  // Identify Tips
  const tips = docs.filter(d => {
    const nextId = d.data.nextQualiaDocId;
    return !nextId || !docMap.has(nextId);
  });

  console.log(`\nFound ${tips.length} TIPS (Leaves):`);
  tips.forEach(t => console.log(` - ${t.id} (Created: ${t.createTime.toISOString()})`));

  const lineages = [];

  for (const tip of tips) {
    const lineage = [];
    let current = tip;
    const visited = new Set();

    console.log(`Tracing lineage for tip ${tip.id}...`);

    while (current) {
      if (visited.has(current.id)) {
        console.error(`CYCLE DETECTED in lineage for tip ${tip.id} at node ${current.id}`);
        lineage.unshift({ ...current, id: `CYCLE_AT_${current.id}`, isCycle: true });
        break;
      }
      visited.add(current.id);
      lineage.unshift(current);
      current = childToParent.get(current.id);
    }
    lineages.push(lineage);
  }

  for (let i = 0; i < lineages.length; i++) {
    console.log(`\n=== BRANCH ${i + 1} (Tip: ${lineages[i][lineages[i].length - 1].id}) ===`);
    const lineage = lineages[i];

    for (let j = 0; j < lineage.length; j++) {
      const doc = lineage[j];
      if (doc.isCycle) {
        console.log(`!!! CYCLE DETECTED !!!`);
        continue;
      }

      const prevDoc = (j > 0 && !lineage[j - 1].isCycle) ? lineage[j - 1] : null;

      // Check if this doc is shared with ALL other lineages
      // Wait, if we have dis-joint sets (2 completely separate trees), then no doc is shared by ALL.
      // Only check if it's shared with ANY other lineage?
      // Let's simplified check: if this node appears in >1 lineages.

      let sharedCount = 0;
      for (const l of lineages) {
        if (l.find(d => d.id === doc.id)) sharedCount++;
      }
      const isShared = sharedCount > 1;

      // Only print if NOT shared OR if it's the first time we encouter this shared node in the print loop?
      // If we print all branches, shared nodes will be printed multiple times.
      // Let's just print simple marker.

      const prefix = isShared ? `[SHARED x${sharedCount}]` : `[BRANCH ${i + 1}]`;

      // Optimization: If it's the 2nd+ branch and we are in the shared section, skip details?
      // BUT the user wants to understand the diff.
      // Let's print details only for the first branch that covers this shared node.

      // Find if this node was already printed in a previous branch loop?
      let alreadyPrinted = false;
      for (let k = 0; k < i; k++) {
        if (lineages[k].find(d => d.id === doc.id)) {
          alreadyPrinted = true;
          break;
        }
      }

      if (alreadyPrinted) {
        // Just print one line summary
        // console.log(`${prefix} ${doc.createTime.toISOString()} | Doc: ${doc.id} (See Branch 1)`);
        continue;
      }

      const nodeCount = doc.data.nodes ? Object.keys(doc.data.nodes).length : 0;

      if (prevDoc) {
        const diff = calculateNodeDiff(prevDoc.data.nodes, doc.data.nodes);
        console.log(`${prefix} ${doc.createTime.toISOString()} | Doc: ${doc.id} | Nodes: ${nodeCount} | Diff: +${diff.addedIds.length} -${diff.removedIds.length} ~${diff.modifiedIds.length}`);

        if (diff.addedIds.length > 0) {
          console.log('    ADDED:');
          diff.addedIds.forEach(id => console.log(`      ${id}:`, JSON.stringify(doc.data.nodes[id])));
        }
        if (diff.removedIds.length > 0) {
          console.log('    REMOVED:');
          diff.removedIds.forEach(id => console.log(`      ${id}`));
        }
        if (diff.modifiedIds.length > 0) {
          console.log('    MODIFIED:');
          diff.modifiedIds.forEach(id => {
            console.log(`      ${id} NEW:`, JSON.stringify(doc.data.nodes[id]));
            console.log(`           OLD:`, JSON.stringify(prevDoc.data.nodes[id]));
          });
        }

      } else {
        console.log(`${prefix} ${doc.createTime.toISOString()} | Doc: ${doc.id} (ROOT/START) | Nodes: ${nodeCount}`);
      }
    }
  }
}

analyzeFork().catch(console.error);
