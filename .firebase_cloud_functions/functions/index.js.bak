import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { onDocumentCreatedWithAuthContext } from "firebase-functions/v2/firestore";
import { GoogleGenAI } from "@google/genai";
import { logger } from "firebase-functions/v1";
import { BASE_QUALIA } from "../../constants.js";
import { COMMUNICATION_SCHEMA } from "../../types.js";

const geminiApiKey = defineSecret("GEMINI_API_KEY");

initializeApp();
const db = getFirestore();
const qualiaCollection = db.collection("qualia");
const qualiaDocsCollection = db.collection("qualiaDocs");
const qualiaCommunicationsCollection = db.collection("qualiaCommunications");


async function gemini(responseSchema, systemInstruction, userText) {
  const ai = new GoogleGenAI({
    apiKey: geminiApiKey,
  });
  const config = {
    thinkingConfig: {
      thinkingBudget: -1,
    },
    responseMimeType: "application/json",
    responseSchema: responseSchema,
    systemInstruction: systemInstruction,
  };
  const model = "gemini-2.5-flash-lite";
  const contents = [
    {
      role: "user",
      parts: [
        {
          text: userText,
        },
      ],
    },
  ];

  const response = await ai.models.generateContentStream({
    model,
    config,
    contents,
  });
  const result = [];
  for await (const chunk of response) {
    logger.info(chunk.text);
    result.push(chunk.text);
  }
  return JSON.parse(result.join(""));
}

function getResponses(qualiaDocContent, receivedCommunication) {
  return gemini(
    COMMUNICATION_SCHEMA,
    JSON.stringify(qualiaDocContent),
    JSON.stringify(receivedCommunication),
  );
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || "Assertion failed");
  }
}

function qDocComInfo(comId, com, thoughts) {
  const res = {
    content: {
      [comId]: {
        communication: com,
      },
    },
  };
  if (thoughts !== undefined) {
    res["thoughts"] = thoughts;
  }
  return res;
}

async function moveMoney(fromQualiaId, toQualiaId, money) {
  if (money === 0 || fromQualiaId === toQualiaId) return;
  return await qualiaCollection
    .doc(fromQualiaId)
    .update({ money: FieldValue.increment(-money) })
    .then(() =>
      qualiaCollection
        .doc(toQualiaId)
        .update({ money: FieldValue.increment(money) }),
    );
}

async function createQualia(baseCommunication, qualiaId, money) {
  const toQualiaDocId = (
    await qualiaDocsCollection.add({
      content: { communicationId: baseCommunication },
    })
  ).id;
  const qualia = {
    money: money,
    qualiaDocId: toQualiaDocId,
  };
  await qualiaCollection.doc(qualiaId).create(qualia);
  return qualia;
}

export const qualiaCommunicationsHandler = onDocumentCreatedWithAuthContext(
  "communications/{communicationId}",
  async (event) => {
    logger.info(event);
    const receivedCommunication = event.data.data();
    const fromQualiaId = receivedCommunication.fromQualiaId;
    const authId = event.authId;
    assert(
      event.authType === "system" || fromQualiaId === authId,
      `Unauthorized ${event.authType} ${authId}`,
    );
    const fromQualia =
      (await qualiaCollection.doc(fromQualiaId).get()).data() ||
      createQualia(
        {
          communicationType: "QUALIA_TO_QUALIA",
          message: BASE_QUALIA,
        },
        fromQualiaId,
        100,
      );
    const money = receivedCommunication.money;
    assert(
      receivedCommunication.communicationType !== undefined ||
        (money > 0 && money <= fromQualia.money),
      `Money should be > 0 for non-self communication or insufficient balance ${fromQualia.money} should be >= ${money}`,
    );
    if (receivedCommunication.isNewQualia) {
      const baseCommunication = structuredClone(receivedCommunication);
      if (!baseCommunication.message) {
        baseCommunication.message = BASE_QUALIA;
      }
      createQualia(baseCommunication, receivedCommunication.toQualiaId, 0);
      await qualiaCommunicationsCollection.add({
        fromQualiaId: receivedCommunication.toQualiaId,
        toQualiaId: fromQualiaId,
        isNewQualia: false,
        message: "Qualia created.",
        money: 1,
        ack: false,
      });
      await moveMoney(fromQualiaId, receivedCommunication.toQualiaId, money);
      return;
    }
    let toQualia;
    let toQualiaId;
    if (receivedCommunication.communicationType === undefined) {
      toQualiaId = receivedCommunication.toQualiaId;
      const toQualiaRef = await qualiaCollection.doc(toQualiaId).get();
      assert(toQualiaRef.exists, `Receiver ${toQualiaId} does not exist`);
      toQualia = toQualiaRef.data();
    } else {
      toQualiaId = fromQualiaId;
      toQualia = fromQualia;
    }
    const toQualiaDocRef = qualiaDocsCollection.doc(toQualia.qualiaDocId);
    const toQualiaDoc = (await toQualiaDocRef.get()).data();
    const communicationId = event.params.communicationId;
    const responses = getResponses(toQualiaDoc, receivedCommunication);
    logger.info(responses);
    toQualiaDocRef().update(
      qDocComInfo(communicationId, receivedCommunication),
    );
    for (const response of responses) {
      const responseCommunication = response.communication;
      const responseCommunicationCollection =
        responseCommunication.communicationType === "QUALIA_TO_HUMAN"
          ? "humanCommunications" // eslint-disable-line
          : "qualiaCommunications"; // eslint-disable-line
      const responseCommunicationDoc = db
        .collection(responseCommunicationCollection)
        .doc();
      await qualiaDocsCollection
        .doc(fromQualia.qualiaDocId)
        .update(
          qDocComInfo(
            responseCommunicationDoc.id,
            responseCommunication,
            response.thoughts,
          ),
        );
      await responseCommunicationDoc.add(responseCommunication);
    }
    moveMoney(fromQualiaId, toQualiaId, money);
    await db
      .collection("qualiaCommunications")
      .doc(communicationId)
      .update({ ack: true });
  },
);
