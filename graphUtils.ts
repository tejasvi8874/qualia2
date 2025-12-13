import { QualiaDoc, QualiaNode, IntegrationOperation, Communication } from "./types";
import { Timestamp } from "firebase/firestore";

function formatTimeDelta(timestamp: Timestamp): string {
    const now = Date.now();
    const diff = Math.max(0, now - timestamp.toMillis());

    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const weeks = Math.floor(days / 7);
    const months = Math.floor(days / 30);
    const years = Math.floor(days / 365);

    if (years > 0) {
        const remainingMonths = Math.floor((days % 365) / 30);
        return remainingMonths > 0 ? `${years} years ${remainingMonths} months ago` : `${years} years ago`;
    }
    if (months > 0) {
        const remainingDays = days % 30;
        return remainingDays > 0 ? `${months} months ${remainingDays} days ago` : `${months} months ago`;
    }
    if (weeks > 0) {
        const remainingDays = days % 7;
        return remainingDays > 0 ? `${weeks} weeks ${remainingDays} days ago` : `${weeks} weeks ago`;
    }
    if (days > 0) {
        const remainingHours = hours % 24;
        return remainingHours > 0 ? `${days} days ${remainingHours} hours ago` : `${days} days ago`;
    }
    if (hours > 0) {
        const remainingMinutes = minutes % 60;
        return remainingMinutes > 0 ? `${hours}hr ${remainingMinutes} minutes ago` : `${hours}hr ago`;
    }
    if (minutes > 0) {
        return `${minutes} minutes ago`;
    }
    return `${seconds} seconds ago`;
}

function serializeCommunication(comm: Communication): Record<string, any> {
    const {
        ack,
        processingBefore,
        delaySeconds,
        deliveryTime,
        receivedTime,
        id, // Excluding ID as well to reduce noise, unless critical? User said "irrelevant fields".
        ...rest
    } = comm;

    const result: any = rest;

    if (receivedTime) {
        result.receivedTime = receivedTime.toDate().toISOString();
        result.timeAgo = formatTimeDelta(receivedTime);
    } else if (deliveryTime) {
        // When self is the sender, we use delivery time.
        result.receivedTime = deliveryTime.toDate().toISOString();
        result.timeAgo = formatTimeDelta(deliveryTime);
    }

    return result;
}

export function serializeQualia(doc: QualiaDoc, pendingCommunications: Communication[] = []): string {
    const nodes = doc.nodes || {};
    const pending = pendingCommunications.map(serializeCommunication);

    // Build adjacency list (Parent -> Children) and in-degree (Child -> Parents count)
    // Actually, for "roots" we want nodes that are not assumptions of anyone.
    // So we need to know who uses whom.
    const parentCount: Record<string, number> = {};
    Object.keys(nodes).forEach(id => parentCount[id] = 0);

    Object.values(nodes).forEach(node => {
        node.assumptionIds.forEach(childId => {
            if (parentCount[childId] === undefined) parentCount[childId] = 0;
            parentCount[childId]++;
        });
    });

    // Initial set: nodes with parentCount == 0 (not assumptions of anyone)
    // If a node is not in 'nodes' but referenced, ignore it or handle gracefully.
    let currentSet = Object.keys(nodes).filter(id => parentCount[id] === 0);

    // If graph has cycles or is empty, we might start with empty set. 
    // But we should try to serialize everything.
    // If currentSet is empty but we have nodes, pick the oldest node overall?
    if (currentSet.length === 0 && Object.keys(nodes).length > 0) {
        // Fallback: pick oldest node
        const sorted = Object.values(nodes).sort((a, b) => a.timestamp.toMillis() - b.timestamp.toMillis());
        if (sorted.length > 0) currentSet.push(sorted[0].id);
    }

    const serializedNodes: any[] = [];
    const visited = new Set<string>();

    while (currentSet.length > 0) {
        // Prioritize older node
        currentSet.sort((a, b) => {
            const nodeA = nodes[a];
            const nodeB = nodes[b];
            if (!nodeA || !nodeB) {
                throw new BaseGraphCorruptionError([a, b].filter(id => !nodes[id]), "missing nodes during sorting");
            }
            return nodeA.timestamp.toMillis() - nodeB.timestamp.toMillis();
        });

        const nodeId = currentSet.shift()!;
        if (visited.has(nodeId)) continue;
        visited.add(nodeId);

        const node = nodes[nodeId];
        if (!node) continue;

        const assumptions = node.assumptionIds.map(childId => {
            const child = nodes[childId];
            if (!child) {
                console.log(nodes);
                throw new BaseGraphCorruptionError([childId], `missing assumption node for ${node.id}`);
            }
            return {
                id: childId,
                assumption: child.conclusion
            };
        });

        serializedNodes.push({
            id: node.id,
            conclusion: node.conclusion,
            assumptions: assumptions
        });

        // Add children to current set
        // "Once ... included ... add its children"
        node.assumptionIds.forEach(childId => {
            if (!visited.has(childId) && nodes[childId]) {
                currentSet.push(childId);
            }
        });

        // If set becomes empty but we haven't visited all, scan for unvisited
        if (currentSet.length === 0 && visited.size < Object.keys(nodes).length) {
            const unvisited = Object.keys(nodes).filter(id => !visited.has(id));
            if (unvisited.length > 0) {
                // Pick oldest unvisited
                unvisited.sort((a, b) => nodes[a].timestamp.toMillis() - nodes[b].timestamp.toMillis());
                currentSet.push(unvisited[0]);
            }
        }
    }

    return JSON.stringify({ "qualia": serializedNodes, "recentCommunications": pending });
}

export class BaseGraphCorruptionError extends Error {
    missingIds: string[];
    constructor(missingIds: string[], context: string) {
        super(`Base graph corruption - ${context}: ${missingIds.join(", ")}`);
        this.missingIds = missingIds;
        this.name = "BaseGraphCorruptionError";
    }
}

export class GraphValidationError extends Error {
    missingIds: string[];
    constructor(missingIds: string[]) {
        super(`Missing referred IDs under assumptions: ${missingIds.join(", ")}`);
        this.missingIds = missingIds;
        this.name = "GraphValidationError";
    }
}

export function applyOperations(doc: QualiaDoc, operations: IntegrationOperation[]): QualiaDoc {
    // Initialize nodes if not present
    if (!doc.nodes) {
        doc = { ...doc, nodes: {} };
    }

    // Pre-check base document integrity
    for (const node of Object.values(doc.nodes)) {
        for (const assumptionId of node.assumptionIds) {
            if (!doc.nodes[assumptionId]) {
                throw new BaseGraphCorruptionError([assumptionId], `Conclusion ${node.id} refers to missing assumption`);
            }
        }
    }

    const newDoc = { ...doc, nodes: { ...doc.nodes } };
    const createdNodeIds = new Set<string>();
    const missingIds = new Set<string>();

    // Simple Base64 UUID generator (22 chars, ~132 bits of entropy)
    const generateId = () => {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
        let result = '';
        for (let i = 0; i < 22; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    };

    for (const op of operations) {
        if (op.type === "CREATE") {
            if (!op.createId) {
                throw new GraphValidationError([`CREATE operation missing createId`]);
            }
            const id = op.createId;

            // Check for collision with existing nodes
            if (doc.nodes[id]) {
                const existingNode = doc.nodes[id];
                throw new GraphValidationError([
                    `CREATE operation failed: Conclusion with ID ${id} already exists. Existing conclusion content: ${existingNode.conclusion}`
                ]);
            }

            // Assumptions are used directly as provided by LLM
            const resolvedAssumptions = op.assumptions || [];

            // Validate conclusion is non-empty
            if (!op.conclusion || op.conclusion.trim() === "") {
                throw new GraphValidationError([`CREATE operation with id ${id} has empty conclusion`]);
            }

            const newNode: QualiaNode = {
                id: id,
                conclusion: op.conclusion,
                assumptionIds: resolvedAssumptions,
                timestamp: Timestamp.now()
            };
            newDoc.nodes[newNode.id] = newNode;
            createdNodeIds.add(newNode.id);
        } else if (op.type === "DELETE") {
            if (!op.deleteIds || op.deleteIds.length === 0) {
                throw new GraphValidationError([`DELETE operation missing deleteIds or empty`]);
            }

            for (const idToDelete of op.deleteIds) {
                if (!newDoc.nodes[idToDelete]) {
                    missingIds.add(idToDelete);
                    continue;
                }
                delete newDoc.nodes[idToDelete];
            }
        }
    }

    // Validation: Check ALL nodes for missing assumptions, not just created ones.
    // Since we might have deleted assumptions of existing nodes.
    for (const node of Object.values(newDoc.nodes)) {
        for (const assumptionId of node.assumptionIds) {
            if (!newDoc.nodes[assumptionId]) {
                // This catches the case where we deleted an assumption but didn't delete the parent.
                // We should probably throw a GraphValidationError here to tell LLM to delete the parent too.
                throw new GraphValidationError([`Conclusion ${node.id} refers to missing assumption ${assumptionId}. If you removed ${assumptionId}, you must also removed ${node.id}.`]);
            }
        }
    }

    // Validation: Check newly created nodes
    for (const id of createdNodeIds) {
        const node = newDoc.nodes[id];
        if (node) {
            for (const assumptionId of node.assumptionIds) {
                if (!newDoc.nodes[assumptionId]) {
                    missingIds.add(assumptionId);
                }
            }
        }
    }

    if (missingIds.size > 0) {
        throw new GraphValidationError(Array.from(missingIds));
    }

    return newDoc;
}

export function detectCycles(doc: QualiaDoc): string[] | null {
    const nodes = doc.nodes || {};
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const path: string[] = [];

    function dfs(nodeId: string): boolean {
        visited.add(nodeId);
        recursionStack.add(nodeId);
        path.push(nodeId);

        const node = nodes[nodeId];
        if (node) {
            for (const childId of node.assumptionIds) {
                if (!visited.has(childId)) {
                    if (dfs(childId)) return true;
                } else if (recursionStack.has(childId)) {
                    path.push(childId); // Add closure
                    return true;
                }
            }
        }

        recursionStack.delete(nodeId);
        path.pop();
        return false;
    }

    for (const nodeId of Object.keys(nodes)) {
        if (!visited.has(nodeId)) {
            if (dfs(nodeId)) return path;
        }
    }

    return null;
}
