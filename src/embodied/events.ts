import type { ActionResult, EmbodiedActionType } from './backend.js';

export interface EmbodiedActionStarted {
  readonly actionId: string;
  readonly sessionId: string;
  readonly actionType: EmbodiedActionType;
}

export interface EmbodiedActionCompleted {
  readonly actionId: string;
  readonly sessionId: string;
  readonly result: ActionResult;
}

export interface EmbodiedFrame {
  readonly sessionId: string;
  readonly step: number;
}

export interface EmbodiedError {
  readonly actionId: string;
  readonly sessionId: string;
  readonly error: string;
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'embodied/action-started'(payload: EmbodiedActionStarted): void;
    'embodied/action-completed'(payload: EmbodiedActionCompleted): void;
    'embodied/frame'(payload: EmbodiedFrame): void;
    'embodied/error'(payload: EmbodiedError): void;
  }
}