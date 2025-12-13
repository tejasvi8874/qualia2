import { Schema } from "firebase/ai";
import { Timestamp } from "firebase/firestore";

export type CommunicationType = "HUMAN_TO_QUALIA" | "QUALIA_TO_HUMAN" | "QUALIA_TO_QUALIA" | "HUMAN_TO_HUMAN";


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
  seen: boolean;
  processingBefore?: Timestamp;
  reasoning?: string;
  fromQualiaId: string;
  isNewQualia?: boolean;
  money?: number;
  context?: string;
  delaySeconds?: number;
  deliveryTime?: Timestamp;
  receivedTime?: Timestamp;
  isoDeliveryTime?: string;
}

import { FUNCTION_NAMES } from "./functions/src/shared";



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
            enum: ["QUALIA_TO_HUMAN", "QUALIA_TO_QUALIA"],
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

export type FunctionName = typeof FUNCTION_NAMES[keyof typeof FUNCTION_NAMES];

export interface FunctionResult {
  value?: any;
  error?: string;
}

export interface FunctionCall {
  id?: string;
  qualiaId: string;
  functionName: FunctionName;
  parameters: any;
  result?: FunctionResult;
  createTime?: Timestamp;
}

export interface Communications {
  reasoning?: string;
  communications: Communication[];
}

export interface QualiaNode {
  id: string;
  conclusion: string;
  assumptionIds: string[];
  timestamp: Timestamp;
}

export interface QualiaDoc {
  qualiaId: string;
  nodes: Record<string, QualiaNode>;
  nextQualiaDocId: string;
  processingBefore?: Timestamp;
  createdTime: Timestamp;
  lockOwner?: string;
}

export const INTEGRATION_SCHEMA = Schema.object({
  properties: {
    reasoning: Schema.string(),
    operations: Schema.array({
      items: Schema.object({
        properties: {
          reasoning: Schema.string({ description: "Optional scratch place to think about the operation." }),
          type: Schema.enumString({ enum: ["CREATE", "DELETE"], description: "Type of operation." }),
          createId: Schema.string({ description: "Unique ID for the new conclusion. Required for CREATE." }),
          conclusion: Schema.string({ description: "The content of the new conclusion. Required for CREATE." }),
          assumptions: Schema.array({ items: Schema.string(), description: "List of IDs of existing conclusions to be used as assumptions for the new conclusion. Required for CREATE." }),
          deleteIdsPathTillRoot: Schema.array({ items: Schema.string(), description: "Path of conclusion IDs to delete which must include root conclusion. Required for DELETE. If an assumption or conclusion is deleted, recursively all its parent conclusions must also be deleted till the root conclusion. Recreate the updated conclusions with appropriate assumptions if needed." }),
        },
        propertyOrdering: ["reasoning", "type", "createId", "conclusion", "assumptions", "deleteIdsPathTillRoot"],
        optionalProperties: ["reasoning", "createId", "conclusion", "assumptions", "deleteIdsPathTillRoot"],
      }),
    }),
  },
  propertyOrdering: ["reasoning", "operations"],
  optionalProperties: ["reasoning"],
});

export interface IntegrationOperation {
  reasoning?: string;
  type: "CREATE" | "DELETE";
  createId?: string;
  conclusion?: string;
  assumptions?: string[];
  deleteIdsPathTillRoot?: string[];
}

export interface IntegrationResponse {
  reasoning?: string;
  operations: IntegrationOperation[];
}

export interface QualiaDocOperationRecord {
  qualiaId: string;
  oldQualiaDocId: string;
  newQualiaDocId?: string;
  operations: IntegrationOperation[];
  communicationIds: string[];
  createdTime: Timestamp;
  error?: string;
  reasoning?: string;
}

export interface Qualia {
  qualiaId: string;
  money: number;
  phoneNumber?: string;
  currentQualiaDocId?: string;
  processingBefore?: Timestamp;
  lockOwner?: string;
}

// Uses a unified 'onAction' prop to handle switching and creation
export interface ContextQualia {
  id: string;
  name: string;
  lastContactTime: Timestamp;
}
