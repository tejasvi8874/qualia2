import { Schema } from "firebase/ai";
import { Timestamp } from "firebase/firestore";

export type CommunicationType = "HUMAN_TO_QUALIA" | "QUALIA_TO_HUMAN" | "QUALIA_TO_QUALIA";


export interface Contact {
  names: string[];
  qualiaId: string;
  lastContactTime: Timestamp;
}

export interface PhoneContact {
  name: string;
  phoneNumber: string;
}

export interface Contacts {
  qualiaId: string;
  qualiaContacts?: Contact[];
  phoneContacts?: PhoneContact[];
}

export interface Communication {
  id?: string;
  fromQualiaName: string;
  toQualiaName: string;
  toQualiaId: string;
  communicationType: CommunicationType;
  message: string;
  // Instead of boolean, it is status enum
  ack: boolean;
  processingBefore?: Timestamp;
  reasoning?: string;
  fromQualiaId: string;
  isNewQualia?: boolean;
  money?: number;
  context?: string;
  delaySeconds?: number;
  deliveryTime?: Timestamp;
  isoDeliveryTime?: string;
}

export const COMMUNICATION_SCHEMA = Schema.object({
  properties: {
    reasoning: Schema.string(),
    communications: Schema.array({
      items: Schema.object({
        properties: {
          reasoning: Schema.string(),
          toQualiaId: Schema.string(),
          toQualiaName: Schema.string(),
          fromQualiaName: Schema.string(),
          communicationType: Schema.enumString({
            enum: ["HUMAN_TO_QUALIA", "QUALIA_TO_HUMAN", "QUALIA_TO_QUALIA"],
          }),
          isNewQualia: Schema.boolean(),
          money: Schema.number(),
          message: Schema.string(),
          context: Schema.string(),
          delaySeconds: Schema.number(),
          isoDeliveryTime: Schema.string(),
        },
        propertyOrdering: [
          "context",
          "reasoning",
          "communicationType",
          "toQualiaName",
          "toQualiaId",
          "fromQualiaName",
          "isNewQualia",
          "money",
          "message",
          "delaySeconds",
          "isoDeliveryTime",
        ],
        optionalProperties: [
          "reasoning",
          "toQualiaId",
          "context",
          "delaySeconds",
          "isoDeliveryTime",
          "isNewQualia",
          "money",
        ],
      }),
    }),
  },
  propertyOrdering: ["reasoning", "communications"],
  optionalProperties: ["reasoning", "communications"],
});

export interface Communications {
  reasoning?: string;
  communications: Communication[];
}

export interface QualiaDoc {
  qualiaId: string;
  content: string[];
  nextQualiaDocId: string;
  processingBefore?: Timestamp;
}

export interface CompactedQualia {
  reasoning?: string;
  qualia: string;
}

export const QUALIA_SCHEMA = Schema.object({
  properties: {
    reasoning: Schema.string(),
    qualia: Schema.string(),
  },
  propertyOrdering: ["reasoning", "qualia"],
  optionalProperties: ["reasoning"],
});

export interface Qualia {
  qualiaId: string;
  money: number;
  phoneNumber?: string;
}

// Uses a unified 'onAction' prop to handle switching and creation
export interface ContextQualia {
  id: string;
  name: string;
  lastContactTime: Timestamp;
}


