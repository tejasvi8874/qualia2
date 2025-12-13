/**
 * Import function triggers from their respective submodules:
 *
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

import { setGlobalOptions } from "firebase-functions";
import * as logger from "firebase-functions/logger";

// Start writing functions
// https://firebase.google.com/docs/functions/typescript

// For cost control, you can set the maximum number of containers that can be
// running at the same time. This helps mitigate the impact of unexpected
// traffic spikes by instead downgrading performance. This limit is a
// per-function limit. You can override the limit for each function using the
// `maxInstances` option in the function's options, e.g.
// `onRequest({ maxInstances: 5 }, (req, res) => { ... })`.
// NOTE: setGlobalOptions does not apply to functions using the v1 API. V1
// functions should each use functions.runWith({ maxInstances: 10 }) instead.
// In the v1 API, each function can only serve one request per container, so
// this will be the maximum concurrent request count.
setGlobalOptions({ maxInstances: 10 });

// export const helloWorld = onRequest((request, response) => {
//   logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });


import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getDatabase } from "firebase-admin/database";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { onDocumentCreatedWithAuthContext } from "firebase-functions/v2/firestore";
import { onValueWritten } from "firebase-functions/v2/database";
import { FUNCTION_NAMES } from "./shared";


initializeApp();


// export async function moveMoney(fromQualiaId, toQualiaId, money) {
//   if (money === 0 || fromQualiaId === toQualiaId) return;
//   return await qualiaCollection
//     .doc(fromQualiaId)
//     .update({ money: FieldValue.increment(-money) })
//     .then(() =>
//       qualiaCollection
//         .doc(toQualiaId)
//         .update({ money: FieldValue.increment(money) }),
//     );
// }


// Function Registry
const functionRegistry = {
    [FUNCTION_NAMES.ECHO]: async (params: any) => {
        return params;
    },
    [FUNCTION_NAMES.ADD]: async (params: any) => {
        return (params.a || 0) + (params.b || 0);
    },
    [FUNCTION_NAMES.GET_CUSTOM_TOKEN]: async (params: any, qualiaId: string) => {
        return await getAuth().createCustomToken(qualiaId);
    },
};

export const functionCalls = onDocumentCreatedWithAuthContext(
    "functionCalls/{callId}",
    async (event) => {
        const snapshot = event.data;
        if (!snapshot) {
            return;
        }
        const data = snapshot.data();

        // Only process if result is null (new request)
        if (data.result !== undefined) {
            return;
        }

        logger.info(`Received function call: ${data.functionName} (${event.params.callId})`);

        try {
            const func = functionRegistry[data.functionName];
            if (!func) {
                throw new Error(`Function '${data.functionName}' not found`);
            }

            const resultValue = await func(data.parameters, data.qualiaId);

            await snapshot.ref.update({
                result: {
                    value: resultValue,
                    error: null,
                },
            });
            logger.info(`Processed function call: ${data.functionName} (${event.params.callId})`);
        } catch (error) {
            logger.error(`Error processing function call ${event.params.callId}:`, error);
            await snapshot.ref.update({
                result: {
                    value: null,
                    error: JSON.stringify(error),
                },
            });
        }
    }
);

export const onUserStatusChanged = onValueWritten(
    {
        ref: "/status/{userId}/{deviceId}",
        instance: "tstomar-experimental-default-rtdb",
    },
    async (event) => {
        const eventStatus = event.data.after.val();
        const userStatusFirestoreRef = getFirestore().collection("communications");
        const userId = event.params.userId;

        const currentDeviceId = event.params.deviceId;
        const userStatusRef = getDatabase().ref(`status/${userId}`);
        const snapshot = await userStatusRef.once("value");
        const devices = snapshot.val() || {};

        const otherOnlineDevices: string[] = [];
        for (const deviceId in devices) {
            if (deviceId !== currentDeviceId && devices[deviceId].state === "online") {
                const platform = devices[deviceId].platform || "unknown";
                const deviceName = devices[deviceId].deviceName || platform;
                otherOnlineDevices.push(`${deviceName} (${platform})`);
            }
        }

        let message = "";
        const currentPlatform = eventStatus.platform || "unknown";
        const currentDeviceName = eventStatus.deviceName || currentPlatform;

        if (eventStatus.state === "online") {
            // User joined
            if (otherOnlineDevices.length > 0) {
                // Scenario 2: Online -> Online (Additional Device)
                message = `User also joined through ${currentDeviceName} (${currentPlatform}) while already online on [${otherOnlineDevices.join(", ")}].`;
            } else {
                // Scenario 1: Fully Offline -> Online (First Device)
                message = `User joined using ${currentDeviceName} (${currentPlatform}).`;
            }
        } else {
            // User left (offline)
            if (otherOnlineDevices.length > 0) {
                // Scenario 3: Online -> Online (One Device Leaves)
                message = `User left ${currentDeviceName} but is still online on [${otherOnlineDevices.join(", ")}].`;
            } else {
                // Scenario 4: Online -> Fully Offline (Last Device Leaves)
                message = `User is no longer active on any device.`;
            }
        }

        await userStatusFirestoreRef.add({
            fromQualiaId: userId,
            toQualiaId: userId,
            communicationType: "HUMAN_TO_QUALIA",
            message: message,
            deliveryTime: Timestamp.now(),
            seen: true,
            ack: false,
            processingBefore: null,
        });
    }
);

export const onLockClaimReleased = onValueWritten(
    {
        ref: "/locks/{userId}/{deviceId}/{collectionId}/{docId}",
        instance: "tstomar-experimental-default-rtdb",
    },
    async (event) => {
        // Only trigger on deletion (lock release)
        if (event.data.after.exists()) {
            return;
        }

        const { deviceId, collectionId, docId } = event.params;
        logger.info(`Lock claim released for ${collectionId}/${docId} by device ${deviceId}`);

        const docRef = getFirestore().collection(collectionId).doc(docId);

        try {
            await getFirestore().runTransaction(async (transaction) => {
                const doc = await transaction.get(docRef);
                if (!doc.exists) return;

                const data = doc.data();
                // CRITICAL: Only clear the lock if it is still owned by the device that released the claim.
                // This prevents "Split Brain" or "Double Locking" race conditions:
                // 1. Device A holds lock, finishes work, and releases lock (processingBefore: null).
                // 2. Device B immediately acquires lock (processingBefore: <time>, lockOwner: Device B).
                // 3. Device A's cleanup (RTDB deletion) triggers this Cloud Function.
                // 4. Without this check, we would wipe Device B's valid lock.
                // 5. Device C could then acquire the lock, leading to B and C both thinking they have exclusive access.
                // Even with immutable docs, this causes wasted work, orphaned documents (forks), and error noise.
                if (data?.lockOwner === deviceId) {
                    logger.info(`Clearing abandoned lock on ${collectionId}/${docId}`);
                    transaction.update(docRef, { processingBefore: null, lockOwner: null });
                } else {
                    logger.info(`Lock on ${collectionId}/${docId} is owned by ${data?.lockOwner}, not clearing.`);
                }
            });
        } catch (error) {
            logger.error(`Error clearing lock for ${docId}:`, error);
        }
    }
);
