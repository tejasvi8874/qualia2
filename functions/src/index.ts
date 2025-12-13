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
import { onDocumentCreatedWithAuthContext } from "firebase-functions/v2/firestore";
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
