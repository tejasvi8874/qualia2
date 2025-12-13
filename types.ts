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

export interface IsoDeliveryTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second?: number;
  timezone?: string; // Optional: "Z", "+05:30", "-08:00". Defaults to local server time if omitted.
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
  isoDeliveryTime?: IsoDeliveryTime;
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
          isoDeliveryTime: Schema.object({
            properties: {
              year: Schema.number({ description: "Full year (e.g. 2023)" }),
              month: Schema.number({ description: "Month (1-12)" }),
              day: Schema.number({ description: "Day of month (1-31)" }),
              hour: Schema.number({ description: "Hour (0-23)" }),
              minute: Schema.number({ description: "Minute (0-59)" }),
              second: Schema.number({ description: "Second (0-59)" }),
              timezone: Schema.string({ description: "Timezone offset (e.g. 'Z', '+05:30', '-08:00'). Defaults to local server time if omitted." }),
            },
            optionalProperties: ["second", "timezone"],
          }),
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
    reasoning: Schema.string({ description: "Optional ephemeral reasoning for the batch of operations." }),
    operations: Schema.array({
      items: Schema.object({
        properties: {
          reasoning: Schema.string({ description: "Optional ephemeral scratch place to think about the operation." }),
          id: Schema.string({ description: "Unique ID of the conclusion to create or update." }),
          newConclusion: Schema.string({ description: "The new content. If set to empty string (\"\"), the conclusion will be DELETED. If omitted, conclusion text remains unchanged." }),
          addAssumptions: Schema.array({ items: Schema.string(), description: "List of assumption IDs to ADD to this conclusion. If omitted, no assumptions are added." }),
          removeAssumptions: Schema.array({ items: Schema.string(), description: "List of assumption IDs to REMOVE from this conclusion. If omitted, no assumptions are removed." }),
        },
        propertyOrdering: ["reasoning", "id", "newConclusion", "addAssumptions", "removeAssumptions"],
        optionalProperties: ["reasoning", "newConclusion", "addAssumptions", "removeAssumptions"],
      }),
    }),
  },
  propertyOrdering: ["reasoning", "operations"],
  optionalProperties: ["reasoning"],
});

export interface IntegrationOperation {
  reasoning?: string;
  id: string;
  newConclusion?: string;
  addAssumptions?: string[];
  removeAssumptions?: string[];
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
