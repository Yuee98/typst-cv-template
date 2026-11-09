import { POLISH_ERROR_CODES, type PolishErrorCode } from "@/lib/polish/contract";
export class AiError extends Error {
  constructor(readonly code: PolishErrorCode, readonly reason?: string) {
    super(code);
    this.name = "AiError";
  }
}
export function databaseError(error: {
  message: string;
  details?: string | null;
}): AiError {
  const code = POLISH_ERROR_CODES.find(code => code === error.message) ?? "INTERNAL_ERROR";
  return new AiError(code, error.details ?? undefined);
}
