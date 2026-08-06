import type { PolishErrorCode } from "@/lib/polish/contract";
import type {
  PolishFinalizeResult,
  PolishFinalizeStatus,
  PolishLedgerMetadata,
  PolishQuotaStatus,
  PolishReservation,
  PolishTokenUsage,
  ProviderStartedMark,
} from "./quota";
import type { PolishProvider } from "./orchestrator";

export interface PolishFinalizeCall {
  reservationId: string;
  status: PolishFinalizeStatus;
  quotaCharged: boolean;
  providerBillable?: boolean | null;
  usage?: PolishTokenUsage;
  metadata?: PolishLedgerMetadata;
}

export interface PolishRouteDeps {
  verifyAccessToken(token: string): Promise<string | null>;
  hasAcceptedCurrentAiTerms(userId: string): Promise<boolean>;
  reserve(params: { userId: string; requestId: string; clientRequestId: string }): Promise<PolishReservation>;
  markProviderStarted(reservationId: string, providerRequestId?: string): Promise<ProviderStartedMark>;
  finalize(params: PolishFinalizeCall): Promise<PolishFinalizeResult>;
  getQuota(userId: string): Promise<PolishQuotaStatus>;
  provider: PolishProvider;
  providerUserId(userId: string): string;
  model: string;
  aiPolishEnabled: boolean;
  now?: () => number;
  createRequestId?: () => string;
  logger?: (event: PolishLogEvent) => void;
}

export interface PolishLogEvent {
  event:
    | "polish.request.completed"
    | "polish.request.failed"
    | "polish.request.denied"
    | "polish.request.canceled"
    | "polish.finalize_failed"
    | "polish.quota_read_failed"
    | "polish.quota.served"
    | "polish.quota.denied";
  requestId: string;
  userId?: string;
  code?: PolishErrorCode;
  failureStage?: string;
  granularity?: string;
  itemCount?: number;
  contextLevel?: number;
  language?: string;
  attempts?: number;
  providerRequestId?: string;
  upstreamStatus?: number;
  inputCachedTokens?: number;
  inputUncachedTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
}

export interface PolishRouteHandlers {
  POST(request: Request): Promise<Response>;
  GET(request: Request): Promise<Response>;
}
