import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, vi } from "vitest";

import { cloneCvData } from "@/lib/cv/cv-utils";
import type { EncryptedPayload } from "@/lib/cv/encryption";
import { sampleCvDataEn } from "@/lib/cv/sample-data";

type QueryResponse = { data: unknown; error: unknown };

type QueryMethod = "delete" | "eq" | "insert" | "maybeSingle" | "order" | "select" | "single" | "update";

type QueryOperation = {
  args: unknown[];
  method: QueryMethod;
  terminal?: true;
};

export const cloudDocumentColumns =
  "id,title,storage_mode,data,encrypted_payload,schema_version,created_at,updated_at";

export function operation(method: QueryMethod, args: unknown[] = [], terminal = false): QueryOperation {
  return { method, args, ...(terminal ? { terminal: true as const } : {}) };
}

export function loadOperations(id: string): QueryOperation[] {
  return [
    operation("select", [cloudDocumentColumns]),
    operation("eq", ["id", id]),
    operation("maybeSingle", [], true),
  ];
}

export function createSupabaseQuery(response: QueryResponse, expectedOperations: QueryOperation[]) {
  let operationIndex = 0;
  const query: Record<string, ReturnType<typeof vi.fn>> & {
    then?: Promise<QueryResponse>["then"];
  } = {};

  function consume(method: QueryMethod, args: unknown[]) {
    const expected = expectedOperations[operationIndex];
    if (!expected || expected.method !== method) {
      throw new Error(
        `Unexpected Supabase query operation ${method}; expected ${expected?.method ?? "end of query"}.`,
      );
    }
    expect(args).toEqual(expected.args);
    operationIndex += 1;
    return expected;
  }

  for (const method of ["delete", "eq", "insert", "select", "update"] as const) {
    query[method] = vi.fn((...args: unknown[]) => {
      consume(method, args);
      return query;
    });
  }
  for (const method of ["maybeSingle", "order", "single"] as const) {
    query[method] = vi.fn(async (...args: unknown[]) => {
      const expected = consume(method, args);
      if (!expected.terminal) {
        throw new Error(`Supabase query operation ${method} was not expected to be terminal.`);
      }
      return response;
    });
  }
  query.then = (onFulfilled, onRejected) => {
    if (operationIndex !== expectedOperations.length) {
      const next = expectedOperations[operationIndex];
      return Promise.reject(
        new Error(`Supabase query was awaited before required ${next?.method ?? "terminal"} operation.`),
      ).then(onFulfilled, onRejected);
    }
    return Promise.resolve(response).then(onFulfilled, onRejected);
  };

  const from = vi.fn((table: string) => {
    if (table !== "cv_documents") {
      throw new Error(`Unexpected Supabase table ${table}.`);
    }
    return query;
  });
  return {
    assertComplete() {
      expect(from).toHaveBeenCalledTimes(1);
      expect(operationIndex).toBe(expectedOperations.length);
    },
    client: { from } as unknown as SupabaseClient,
    from,
    query,
  };
}

export const encryptedPayload: EncryptedPayload = {
  version: 1,
  algorithm: "AES-GCM",
  kdf: "PBKDF2-SHA-256",
  iterations: 100_000,
  salt: "salt",
  iv: "iv",
  ciphertext: "ciphertext",
};

export function cloudRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cv-1",
    title: "Cloud CV",
    storage_mode: "plain",
    data: cloneCvData(sampleCvDataEn),
    encrypted_payload: null,
    schema_version: sampleCvDataEn.schemaVersion,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}
