import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createServiceClient,
  getGlobalUsageRow,
  getLedgerRow,
  getUsageRow,
  RUN_DB_TESTS,
  sleep,
  tryReserve,
} from "./helpers";
import {
  attemptMetadata,
  completePayload,
  costObservation,
  observedUsage,
  routeObservation,
  SettlementHarness,
} from "./provider-attempt-settlement-fixtures";
import {
  runOwnerSql,
  type OwnerSqlResult,
} from "./runtime-contract-fixtures";

const DB_CONTAINER = "supabase_db_typst-cv-template";
const LOCK_OBSERVATION_MS = 150;

interface BarrierSqlProcess {
  ready: Promise<void>;
  result: Promise<OwnerSqlResult>;
  release: () => void;
}

function startOwnerSqlWithBarrier(
  sql: string,
  marker: string,
  releaseSql?: string,
): BarrierSqlProcess {
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let readySettled = false;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  let released = releaseSql === undefined;
  let release = () => undefined;
  const result = new Promise<OwnerSqlResult>((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "exec",
        "-i",
        DB_CONTAINER,
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "--set",
        "ON_ERROR_STOP=1",
        "--no-psqlrc",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const observe = () => {
      if (!readySettled && `${stdout}\n${stderr}`.includes(marker)) {
        readySettled = true;
        resolveReady();
      }
    };
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      observe();
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      observe();
    });
    child.on("error", (error) => {
      if (!readySettled) {
        readySettled = true;
        rejectReady(error);
      }
      reject(error);
    });
    child.on("close", (status) => {
      if (!readySettled) {
        readySettled = true;
        rejectReady(
          new Error(
            `owner SQL exited before barrier ${marker}: ${stderr || stdout}`,
          ),
        );
      }
      resolve({ status: status ?? -1, stdout, stderr });
    });
    release = () => {
      if (released) {
        return;
      }
      released = true;
      child.stdin.end(releaseSql);
    };
    if (releaseSql === undefined) {
      child.stdin.end(sql);
    } else {
      child.stdin.write(sql);
    }
  });

  return { ready, result, release };
}

function jsonbSql(value: unknown): string {
  return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
}

function isIdentifierContinuationBefore(sql: string, index: number): boolean {
  if (index <= 0) {
    return false;
  }
  const trailingCodeUnit = sql.charCodeAt(index - 1);
  const previousStart =
    trailingCodeUnit >= 0xdc00 &&
    trailingCodeUnit <= 0xdfff &&
    index > 1 &&
    sql.charCodeAt(index - 2) >= 0xd800 &&
    sql.charCodeAt(index - 2) <= 0xdbff
      ? index - 2
      : index - 1;
  const previousCharacter = sql.slice(previousStart, index);
  const codePoint = previousCharacter.codePointAt(0);
  return (
    codePoint !== undefined &&
    (codePoint >= 0x80 || /[A-Za-z0-9_$]/u.test(previousCharacter))
  );
}

function dollarQuoteTagAt(sql: string, index: number): string | null {
  if (isIdentifierContinuationBefore(sql, index)) {
    return null;
  }
  return /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(sql.slice(index))?.[0] ?? null;
}

function isEscapeStringQuote(sql: string, quoteIndex: number): boolean {
  const prefixIndex = quoteIndex - 1;
  return (
    prefixIndex >= 0 &&
    (sql[prefixIndex] === "e" || sql[prefixIndex] === "E") &&
    !isIdentifierContinuationBefore(sql, prefixIndex)
  );
}

function splitExecutableSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let index = 0;
  let quote: "'" | '"' | null = null;
  let quoteBackslashEscapes = false;
  let dollarTag: string | null = null;
  let blockCommentDepth = 0;
  let lineComment = false;

  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];

    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        current += " ";
      }
      index += 1;
      continue;
    }
    if (blockCommentDepth > 0) {
      if (character === "/" && next === "*") {
        blockCommentDepth += 1;
        index += 2;
      } else if (character === "*" && next === "/") {
        blockCommentDepth -= 1;
        index += 2;
        if (blockCommentDepth === 0) {
          current += " ";
        }
      } else {
        index += 1;
      }
      continue;
    }
    if (dollarTag !== null) {
      if (sql.startsWith(dollarTag, index)) {
        current += dollarTag;
        index += dollarTag.length;
        dollarTag = null;
      } else {
        current += character;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      current += character;
      if (quoteBackslashEscapes && character === "\\") {
        if (next === undefined) {
          throw new Error("escape string ended after a backslash");
        }
        current += next;
        index += 2;
        continue;
      }
      if (character === quote) {
        if (next === quote) {
          current += next;
          index += 2;
          continue;
        }
        quote = null;
        quoteBackslashEscapes = false;
      }
      index += 1;
      continue;
    }
    if (character === "-" && next === "-") {
      lineComment = true;
      index += 2;
      continue;
    }
    if (character === "/" && next === "*") {
      blockCommentDepth = 1;
      index += 2;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      quoteBackslashEscapes =
        character === "'" && isEscapeStringQuote(sql, index);
      current += character;
      index += 1;
      continue;
    }
    const detectedDollarTag =
      character === "$" ? dollarQuoteTagAt(sql, index) : null;
    if (detectedDollarTag !== null) {
      dollarTag = detectedDollarTag;
      current += detectedDollarTag;
      index += detectedDollarTag.length;
      continue;
    }
    if (character === ";") {
      if (current.trim() !== "") {
        statements.push(current.trim());
      }
      current = "";
      index += 1;
      continue;
    }
    current += character;
    index += 1;
  }

  if (quote !== null || dollarTag !== null || blockCommentDepth !== 0) {
    throw new Error("migration SQL ended inside a quote or comment");
  }
  if (current.trim() !== "") {
    statements.push(current.trim());
  }
  return statements;
}

type SqlTokenKind = "word" | "string" | "identifier" | "symbol" | "dollar";

interface SqlToken {
  kind: SqlTokenKind;
  value: string;
}

function readQuotedSqlToken(
  sql: string,
  quoteIndex: number,
  quote: "'" | '"',
  backslashEscapes: boolean,
): { token: SqlToken; nextIndex: number } {
  let value = "";
  let index = quoteIndex + 1;
  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];
    if (backslashEscapes && character === "\\") {
      if (next === undefined) {
        throw new Error("escape string ended after a backslash");
      }
      value += next;
      index += 2;
      continue;
    }
    if (character === quote) {
      if (next === quote) {
        value += quote;
        index += 2;
        continue;
      }
      return {
        token: {
          kind: quote === "'" ? "string" : "identifier",
          value,
        },
        nextIndex: index + 1,
      };
    }
    value += character;
    index += 1;
  }
  throw new Error("SQL token ended inside a quoted string or identifier");
}

function tokenizeSqlStatement(statement: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let index = 0;
  while (index < statement.length) {
    const character = statement[index];
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }

    const atWordBoundary = !isIdentifierContinuationBefore(statement, index);
    if (
      atWordBoundary &&
      (character === "e" || character === "E") &&
      statement[index + 1] === "'"
    ) {
      const quoted = readQuotedSqlToken(statement, index + 1, "'", true);
      tokens.push(quoted.token);
      index = quoted.nextIndex;
      continue;
    }
    if (
      atWordBoundary &&
      (character === "u" || character === "U") &&
      statement[index + 1] === "&" &&
      (statement[index + 2] === "'" || statement[index + 2] === '"')
    ) {
      const quote = statement[index + 2] as "'" | '"';
      const quoted = readQuotedSqlToken(statement, index + 2, quote, false);
      tokens.push(quoted.token);
      index = quoted.nextIndex;
      continue;
    }
    if (character === "'" || character === '"') {
      const quoted = readQuotedSqlToken(statement, index, character, false);
      tokens.push(quoted.token);
      index = quoted.nextIndex;
      continue;
    }
    if (character === "$") {
      const tag = dollarQuoteTagAt(statement, index);
      if (tag !== null) {
        const bodyStart = index + tag.length;
        const closingIndex = statement.indexOf(tag, bodyStart);
        if (closingIndex < 0) {
          throw new Error("SQL token ended inside a dollar-quoted body");
        }
        tokens.push({
          kind: "dollar",
          value: statement.slice(bodyStart, closingIndex),
        });
        index = closingIndex + tag.length;
        continue;
      }
    }
    if (/[A-Za-z0-9_$]/u.test(character)) {
      const start = index;
      while (
        index < statement.length &&
        /[A-Za-z0-9_$]/u.test(statement[index])
      ) {
        index += 1;
      }
      tokens.push({
        kind: "word",
        value: statement.slice(start, index).toLowerCase(),
      });
      continue;
    }
    tokens.push({ kind: "symbol", value: character });
    index += 1;
  }
  return tokens;
}

function tokenSignatures(tokens: SqlToken[]): string[] {
  return tokens.map(({ kind, value }) => `${kind}:${value}`);
}

function requireTokenSequence(
  tokens: SqlToken[],
  expected: string[],
  label: string,
): void {
  const actual = tokenSignatures(tokens);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} token sequence drifted: ${JSON.stringify(actual)}`);
  }
}

function isProfileUsageLock(tokens: SqlToken[]): boolean {
  if (tokens[0]?.kind !== "word" || tokens[0].value !== "lock") {
    return false;
  }
  for (let index = 1; index < tokens.length; index += 1) {
    const table = tokens[index];
    if (
      (table.kind === "word" || table.kind === "identifier") &&
      table.value === "ai_profile_usage_daily"
    ) {
      const precedingDot = tokens[index - 1];
      if (
        precedingDot?.kind !== "symbol" ||
        precedingDot.value !== "."
      ) {
        return true;
      }
      const schema = tokens[index - 2];
      if (
        (schema?.kind === "word" || schema?.kind === "identifier") &&
        schema.value === "public"
      ) {
        return true;
      }
    }
  }
  return false;
}

function validateProfileUsageExpansionPrefix(sql: string): void {
  const statements = splitExecutableSqlStatements(sql);
  if (statements.length < 4) {
    throw new Error("profile usage expansion prefix is incomplete");
  }
  const tokenized = statements.map(tokenizeSqlStatement);
  requireTokenSequence(tokenized[0], ["word:begin"], "transaction start");

  const canonicalLock = [
    "word:lock",
    "word:table",
    "word:public",
    "symbol:.",
    "word:ai_profile_usage_daily",
    "word:in",
    "word:access",
    "word:exclusive",
    "word:mode",
  ];
  const profileLocks = tokenized.filter(isProfileUsageLock);
  if (profileLocks.length !== 1) {
    throw new Error(`expected one profile usage lock, found ${profileLocks.length}`);
  }
  requireTokenSequence(tokenized[1], canonicalLock, "profile usage lock");

  const doTokens = tokenized[2];
  if (
    doTokens.length !== 2 ||
    doTokens[0].kind !== "word" ||
    doTokens[0].value !== "do" ||
    doTokens[1].kind !== "dollar"
  ) {
    throw new Error("profile usage empty preflight must be one canonical DO body");
  }
  const bodyStatements = splitExecutableSqlStatements(doTokens[1].value).map(
    tokenizeSqlStatement,
  );
  requireTokenSequence(
    bodyStatements[0] ?? [],
    [
      "word:begin",
      "word:if",
      "word:exists",
      "symbol:(",
      "word:select",
      "word:1",
      "word:from",
      "word:public",
      "symbol:.",
      "word:ai_profile_usage_daily",
      "symbol:)",
      "word:then",
      "word:raise",
      "word:exception",
      "string:DB-010 requires an empty ai_profile_usage_daily preflight",
      "word:using",
      "word:errcode",
      "symbol:=",
      "string:23514",
    ],
    "profile usage empty preflight",
  );
  requireTokenSequence(
    bodyStatements[1] ?? [],
    ["word:end", "word:if"],
    "profile usage empty preflight IF terminator",
  );
  requireTokenSequence(
    bodyStatements[2] ?? [],
    ["word:end"],
    "profile usage empty preflight block terminator",
  );
  if (bodyStatements.length !== 3) {
    throw new Error("profile usage empty preflight contains extra executable SQL");
  }

  const alterPrefix = [
    "word:alter",
    "word:table",
    "word:public",
    "symbol:.",
    "word:ai_profile_usage_daily",
    "word:add",
    "word:column",
    "word:provider_report_incomplete_count",
    "word:integer",
    "word:not",
    "word:null",
    "word:default",
    "word:0",
  ];
  const alterSignatures = tokenSignatures(tokenized[3]);
  if (
    JSON.stringify(alterSignatures.slice(0, alterPrefix.length)) !==
    JSON.stringify(alterPrefix)
  ) {
    throw new Error(
      `profile usage ALTER prefix drifted: ${JSON.stringify(alterSignatures)}`,
    );
  }
}

function completeAttemptSql(
  attemptId: string,
  options: { markerBefore?: string; markerAfter?: string; commit?: boolean } = {},
): string {
  return String.raw`
    \set ON_ERROR_STOP on
    \pset format unaligned
    \pset tuples_only on
    begin;
    set local statement_timeout = '10s';
    set local role service_role;
    ${options.markerBefore ? `\\echo ${options.markerBefore}` : ""}
    select public.complete_ai_polish_provider_attempt(
      '${attemptId}'::uuid,
      'succeeded',
      true,
      false,
      true,
      ${jsonbSql(observedUsage())},
      ${jsonbSql(routeObservation())},
      ${jsonbSql(costObservation())},
      ${jsonbSql(attemptMetadata())}
    );
    reset role;
    ${options.markerAfter ? `\\echo ${options.markerAfter}` : ""}
    ${options.commit === false ? "" : "commit;"}
  `;
}

function finalizeAttemptSql(
  reservationId: string,
  options: { markerBefore?: string; markerAfter?: string; commit?: boolean } = {},
): string {
  return String.raw`
    \set ON_ERROR_STOP on
    \pset format unaligned
    \pset tuples_only on
    begin;
    set local statement_timeout = '10s';
    set local role service_role;
    ${options.markerBefore ? `\\echo ${options.markerBefore}` : ""}
    select public.finalize_ai_polish_request(
      '${reservationId}'::uuid,
      'succeeded',
      true,
      true,
      null,
      '{"usage_schema_version":"attempt_v2"}'::jsonb,
      'durable_cancellation_sequence_v1'
    );
    reset role;
    ${options.markerAfter ? `\\echo ${options.markerAfter}` : ""}
    ${options.commit === false ? "" : "commit;"}
  `;
}

function finalizeCanceledAttemptSql(
  reservationId: string,
  options: { markerBefore?: string; markerAfter?: string; commit?: boolean } = {},
): string {
  return String.raw`
    \set ON_ERROR_STOP on
    \pset format unaligned
    \pset tuples_only on
    begin;
    set local statement_timeout = '10s';
    set local role service_role;
    ${options.markerBefore ? `\\echo ${options.markerBefore}` : ""}
    select public.finalize_ai_polish_request(
      '${reservationId}'::uuid,
      'canceled',
      true,
      null,
      null,
      '{"usage_schema_version":"attempt_v2"}'::jsonb,
      'durable_cancellation_sequence_v1'
    );
    reset role;
    ${options.markerAfter ? `\\echo ${options.markerAfter}` : ""}
    ${options.commit === false ? "" : "commit;"}
  `;
}

function observeCancellationSql(
  reservationId: string,
  options: { markerBefore?: string; markerAfter?: string; commit?: boolean } = {},
): string {
  return String.raw`
    \set ON_ERROR_STOP on
    \pset format unaligned
    \pset tuples_only on
    begin;
    set local statement_timeout = '10s';
    set local role service_role;
    ${options.markerBefore ? `\\echo ${options.markerBefore}` : ""}
    select public.record_ai_polish_request_cancellation(
      '${reservationId}'::uuid,
      'observed'
    );
    reset role;
    ${options.markerAfter ? `\\echo ${options.markerAfter}` : ""}
    ${options.commit === false ? "" : "commit;"}
  `;
}

function startAttemptSql(
  reservationId: string,
  attemptNo: 1 | 2,
  options: { markerBefore?: string; markerAfter?: string; commit?: boolean } = {},
): string {
  return String.raw`
    \set ON_ERROR_STOP on
    \pset format unaligned
    \pset tuples_only on
    begin;
    set local statement_timeout = '10s';
    set local role service_role;
    ${options.markerBefore ? `\\echo ${options.markerBefore}` : ""}
    select public.start_ai_polish_provider_attempt(
      '${reservationId}'::uuid,
      ${attemptNo}
    );
    reset role;
    ${options.markerAfter ? `\\echo ${options.markerAfter}` : ""}
    ${options.commit === false ? "" : "commit;"}
  `;
}

function parentLockSql(reservationId: string, marker: string): string {
  return String.raw`
    \set ON_ERROR_STOP on
    \pset format unaligned
    \pset tuples_only on
    begin;
    set local statement_timeout = '10s';
    set local role service_role;
    select 1
    from public.ai_request_ledger
    where reservation_id = '${reservationId}'::uuid
    for update;
    \echo ${marker}
  `;
}

function finalizeAttemptActionSql(reservationId: string): string {
  return String.raw`
    select public.finalize_ai_polish_request(
      '${reservationId}'::uuid,
      'succeeded',
      true,
      true,
      null,
      '{"usage_schema_version":"attempt_v2"}'::jsonb,
      'durable_cancellation_sequence_v1'
    );
    reset role;
    commit;
  `;
}

function startAttemptActionSql(reservationId: string, attemptNo: 1 | 2): string {
  return String.raw`
    select public.start_ai_polish_provider_attempt(
      '${reservationId}'::uuid,
      ${attemptNo}
    );
    reset role;
    commit;
  `;
}

function staleSnapshotSql(
  attemptId: string,
  isolation: "repeatable read" | "serializable",
  marker: string,
): string {
  return String.raw`
    \set ON_ERROR_STOP on
    \pset format unaligned
    \pset tuples_only on
    begin isolation level ${isolation};
    set local statement_timeout = '10s';
    set local role service_role;
    select status
    from public.ai_provider_attempt_ledger
    where attempt_id = '${attemptId}'::uuid;
    \echo ${marker}
  `;
}

function invokeRawFinalize(
  reservationId: string,
  usageSql: string,
  metadataSql = `'${JSON.stringify({ usage_schema_version: "attempt_v2" })}'::jsonb`,
): Record<string, unknown> {
  const result = runOwnerSql(String.raw`
    \set ON_ERROR_STOP on
    \pset format unaligned
    \pset tuples_only on
    begin;
    set local role service_role;
    select public.finalize_ai_polish_request(
      '${reservationId}'::uuid,
      'succeeded',
      true,
      true,
      ${usageSql},
      ${metadataSql},
      'durable_cancellation_sequence_v1'
    );
    reset role;
    commit;
  `);
  const payload = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.startsWith("{"));
  if (!payload) {
    throw new Error(`raw finalize returned no JSON payload: ${result.stdout}`);
  }
  return JSON.parse(payload) as Record<string, unknown>;
}

async function runObservedBlockedRace(
  holderSql: string,
  holderMarker: string,
  contenderSql: string,
  contenderMarker: string,
  holderReleaseSql = "commit;\n",
): Promise<{ holder: OwnerSqlResult; contender: OwnerSqlResult }> {
  const holder = startOwnerSqlWithBarrier(
    holderSql,
    holderMarker,
    holderReleaseSql,
  );
  let released = false;
  try {
    await holder.ready;
    const contender = startOwnerSqlWithBarrier(contenderSql, contenderMarker);
    let contenderSettled = false;
    const contenderResult = contender.result.then((result) => {
      contenderSettled = true;
      return result;
    });
    await contender.ready;
    await sleep(LOCK_OBSERVATION_MS);
    if (contenderSettled) {
      const settled = await contenderResult;
      throw new Error(
        `contender settled before holder release: ${settled.stderr || settled.stdout}`,
      );
    }

    holder.release();
    released = true;
    const holderResult = await holder.result;
    const completedContender = await contenderResult;
    return { holder: holderResult, contender: completedContender };
  } finally {
    if (!released) {
      holder.release();
    }
  }
}

describe("settlement migration SQL parser", () => {
  const canonicalPrefix = String.raw`
    BEGIN;
    LOCK TABLE public.ai_profile_usage_daily IN ACCESS EXCLUSIVE MODE;
    DO $guard$
    BEGIN
      IF EXISTS (SELECT 1 FROM public.ai_profile_usage_daily) THEN
        RAISE EXCEPTION 'DB-010 requires an empty ai_profile_usage_daily preflight'
          USING ERRCODE = '23514';
      END IF;
    END;
    $guard$;
    ALTER TABLE public.ai_profile_usage_daily
      ADD COLUMN provider_report_incomplete_count INTEGER NOT NULL DEFAULT 0,
      ADD CONSTRAINT test_nonnegative
        CHECK (provider_report_incomplete_count >= 0);
  `;

  it("accepts semantic case, whitespace, nested-comment, and dollar-tag variants", () => {
    expect(() => validateProfileUsageExpansionPrefix(canonicalPrefix)).not.toThrow();
    const equivalent = String.raw`
      /* BEGIN; LOCK /* nested ; DO $bad$ */ ALTER ; */ bEgIn ;
      LoCk /* ONLY; NOWAIT; */ TaBlE public . ai_profile_usage_daily
        In AcCeSs ExClUsIvE MoDe ;
      dO $$
      BeGiN
        -- UPDATE public.ai_profile_usage_daily; semicolon ;
        iF ExIsTs ( SeLeCt 1 FrOm public . ai_profile_usage_daily ) ThEn
          /* RAISE ; /* nested body ; */ SELECT ; */
          rAiSe ExCePtIoN 'DB-010 requires an empty ai_profile_usage_daily preflight'
            uSiNg ErRcOdE = '23514' ;
        eNd iF ;
      EnD ;
      $$ ;
      AlTeR TaBlE public . ai_profile_usage_daily
        AdD CoLuMn provider_report_incomplete_count InTeGeR NoT NuLl DeFaUlT 0,
        AdD CoNsTrAiNt test_nonnegative
          ChEcK (provider_report_incomplete_count >= 0);
    `;
    expect(() => validateProfileUsageExpansionPrefix(equivalent)).not.toThrow();
  });

  it("keeps comments, doubled quotes, E strings, U& quotes, and dollar bodies opaque to top-level semicolons", () => {
    const escapeString = "select E'a" + "\\'" + ";b';";
    const statements = splitExecutableSqlStatements(String.raw`
      -- SELECT ; LOCK ;
      SELECT 'semi;''quote';
      /* outer ; LOCK /* nested ; DO */ ALTER ; */
      SELECT "semi;""identifier";
      SELECT U&'d\0061;ta', U&"id\0061;name";
      DO $$ BEGIN PERFORM ';'; -- body ;
        END; $$;
      DO $tag$ BEGIN /* nested-looking ; */ PERFORM ';'; END; $tag$;
      ${escapeString}
      SELECT 1; -- legal trailing line comment
    `);
    expect(statements).toHaveLength(7);
    expect(tokenSignatures(tokenizeSqlStatement(statements[0]))).toEqual([
      "word:select",
      "string:semi;'quote",
    ]);
    expect(tokenSignatures(tokenizeSqlStatement(statements[1]))).toEqual([
      "word:select",
      'identifier:semi;"identifier',
    ]);
    expect(tokenSignatures(tokenizeSqlStatement(statements[2]))).toEqual([
      "word:select",
      "string:d\\0061;ta",
      "symbol:,",
      "identifier:id\\0061;name",
    ]);
    expect(tokenSignatures(tokenizeSqlStatement(statements[5]))).toEqual([
      "word:select",
      "string:a';b",
    ]);
  });

  it("does not start dollar quotes or quote prefixes inside PG identifier continuations", () => {
    const appended = `${canonicalPrefix}
      SELECT foo$tag$bar;
      LOCK TABLE public.ai_profile_usage_daily IN ACCESS SHARE MODE;
      SELECT baz$tag$qux;
    `;
    const statements = splitExecutableSqlStatements(appended);
    expect(statements).toHaveLength(7);
    expect(tokenSignatures(tokenizeSqlStatement(statements[4]))).toEqual([
      "word:select",
      "word:foo$tag$bar",
    ]);
    expect(tokenSignatures(tokenizeSqlStatement(statements[6]))).toEqual([
      "word:select",
      "word:baz$tag$qux",
    ]);
    expect(() => validateProfileUsageExpansionPrefix(appended)).toThrow(
      /expected one profile usage lock, found 2/u,
    );

    expect(
      splitExecutableSqlStatements(
        "SELECT alpha$tag$beta, foo$$bar, 名$tag$字, a\u0301$tag$b, " +
          "a\u203f$tag$b, 𐐀$tag$x;",
      ),
    ).toHaveLength(1);

    const zwnjTail =
      "SELECT 1 AS a\u200c$tag$b; " +
      "LOCK TABLE public.ai_profile_usage_daily IN ACCESS SHARE MODE; " +
      "SELECT $tag$payload$tag$;";
    expect(splitExecutableSqlStatements(zwnjTail)).toHaveLength(3);
    expect(() =>
      validateProfileUsageExpansionPrefix(`${canonicalPrefix}\n${zwnjTail}`),
    ).toThrow(/expected one profile usage lock, found 2/u);

    expect(
      splitExecutableSqlStatements(
        "SELECT 😀$tag$x, \u0080$tag$y, é$tag$z; " +
          "SELECT ($tag$payload;still_payload$tag$);",
      ),
    ).toHaveLength(2);

    const identifierInternalEscape =
      "SELECT éE'backslash" + "\\'" + "; SELECT 1;";
    expect(splitExecutableSqlStatements(identifierInternalEscape)).toHaveLength(2);
    expect(
      tokenSignatures(
        tokenizeSqlStatement("SELECT éU&'value', øU&\"identifier\""),
      ),
    ).toEqual([
      "word:select",
      "symbol:é",
      "word:u",
      "symbol:&",
      "string:value",
      "symbol:,",
      "symbol:ø",
      "word:u",
      "symbol:&",
      "identifier:identifier",
    ]);
  });

  it("rejects extra prefix SQL, DO-body mutation, and every second profile lock variant", () => {
    expect(() =>
      validateProfileUsageExpansionPrefix(
        canonicalPrefix.replace("DO $guard$", "SELECT 1; DO $guard$"),
      ),
    ).toThrow();
    expect(() =>
      validateProfileUsageExpansionPrefix(
        canonicalPrefix.replace(
          "END IF;",
          "END IF; UPDATE public.ai_profile_usage_daily SET request_count = 0;",
        ),
      ),
    ).toThrow();
    for (const secondLock of [
      "LOCK TABLE ONLY public.ai_profile_usage_daily IN ACCESS EXCLUSIVE MODE;",
      "LOCK TABLE public.ai_profile_usage_daily IN ACCESS SHARE MODE NOWAIT;",
      "LOCK TABLE ai_profile_usage_daily IN ACCESS EXCLUSIVE MODE;",
      "LOCK public.ai_profile_usage_daily IN ACCESS SHARE MODE NOWAIT;",
    ]) {
      expect(() =>
        validateProfileUsageExpansionPrefix(
          canonicalPrefix.replace("DO $guard$", `${secondLock} DO $guard$`),
        ),
      ).toThrow(/expected one profile usage lock/u);
    }
  });

  it("fails closed on unterminated comments and every quoted form", () => {
    const unterminated = [
      "/* outer /* nested */",
      "select 'standard",
      "select \"identifier",
      "select U&'unicode",
      "select U&\"unicode_identifier",
      "do $$ begin;",
      "do $tag$ begin;",
      "select E'escape" + "\\",
    ];
    for (const sql of unterminated) {
      expect(() => splitExecutableSqlStatements(sql)).toThrow();
    }
  });
});

describe.skipIf(!RUN_DB_TESTS)("provider attempt request settlement (real DB)", () => {
  let service: SupabaseClient;
  let harness: SettlementHarness;

  beforeAll(async () => {
    service = createServiceClient();
    harness = new SettlementHarness(service);
    await harness.setup();
  });

  beforeEach(async () => {
    await harness.resetFeature();
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  async function started(label: string, attemptNo: 1 | 2 = 1) {
    const user = await harness.makeUser(label);
    const reservation = await harness.reserveV2(user);
    const attempt = await harness.startAttempt(
      reservation.reservationId,
      attemptNo,
    );
    return { user, reservation, attempt };
  }

  async function completed(
    label: string,
    overrides: Parameters<typeof completePayload>[1] = {},
  ) {
    const value = await started(label);
    const result = await harness.complete(
      completePayload(value.attempt.attemptId, overrides),
    );
    expect(
      result,
      `completion ${label}: ${JSON.stringify(result)}`,
    ).toMatchObject({ ok: true, alreadyCompleted: false });
    return value;
  }

  async function getProfileDaily(profileVersionId = harness.fixture.profileVersionId) {
    const result = await service
      .from("ai_profile_usage_daily")
      .select("*")
      .eq("profile_version_id", profileVersionId)
      .eq("billing_currency", "CNY")
      .single();
    expect(result.error).toBeNull();
    return result.data!;
  }

  async function getProfileDailyRows(
    profileVersionId = harness.fixture.profileVersionId,
  ) {
    const result = await service
      .from("ai_profile_usage_daily")
      .select("*")
      .eq("profile_version_id", profileVersionId)
      .eq("billing_currency", "CNY")
      .order("day");
    expect(result.error).toBeNull();
    return result.data!;
  }

  async function settlementSnapshot(
    userId: string,
    reservationId: string,
    profileVersionId = harness.fixture.profileVersionId,
  ) {
    return {
      request: await getLedgerRow(service, reservationId),
      user: await getUsageRow(service, userId),
      global: await getGlobalUsageRow(service),
      profile: await getProfileDailyRows(profileVersionId),
    };
  }

  async function fullSettlementSnapshot(
    userId: string,
    reservationId: string,
    profileVersionId = harness.fixture.profileVersionId,
  ) {
    const [attempts, rate, currentProfile] = await Promise.all([
      service
        .from("ai_provider_attempt_ledger")
        .select("*")
        .eq("reservation_id", reservationId)
        .order("attempt_no"),
      service
        .from("ai_rate_minutes")
        .select("*")
        .eq("user_id", userId)
        .order("minute_bucket"),
      service
        .from("ai_provider_profile_versions")
        .select("*")
        .eq("id", profileVersionId)
        .single(),
    ]);
    for (const result of [attempts, rate, currentProfile]) {
      expect(result.error).toBeNull();
    }
    return {
      settlement: await settlementSnapshot(userId, reservationId, profileVersionId),
      attempts: attempts.data,
      rate: rate.data,
      currentProfile: currentProfile.data,
    };
  }

  async function mutableSettlementTablesSnapshot() {
    const [attempts, requests, userDaily, globalDaily, profileDaily, rateMinutes] =
      await Promise.all([
        service.from("ai_provider_attempt_ledger").select("*").order("attempt_id"),
        service.from("ai_request_ledger").select("*").order("reservation_id"),
        service.from("ai_usage_daily").select("*").order("day").order("user_id"),
        service.from("ai_global_usage_daily").select("*").order("day"),
        service
          .from("ai_profile_usage_daily")
          .select("*")
          .order("day")
          .order("profile_version_id")
          .order("billing_currency"),
        service
          .from("ai_rate_minutes")
          .select("*")
          .order("minute_bucket")
          .order("user_id"),
      ]);
    for (const result of [
      attempts,
      requests,
      userDaily,
      globalDaily,
      profileDaily,
      rateMinutes,
    ]) {
      expect(result.error).toBeNull();
    }
    return {
      attempts: attempts.data,
      requests: requests.data,
      userDaily: userDaily.data,
      globalDaily: globalDaily.data,
      profileDaily: profileDaily.data,
      rateMinutes: rateMinutes.data,
    };
  }

  it("keeps schema-gated V1 compatibility and the audited V2 finalize ACL", () => {
    runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      do $assertions$
      declare
        v_finalize pg_catalog.pg_proc%rowtype;
        v_finalize_v2 pg_catalog.pg_proc%rowtype;
        v_internal pg_catalog.pg_proc%rowtype;
        v_derive pg_catalog.pg_proc%rowtype;
        v_definition text;
      begin
        if (
          select count(*)
          from pg_catalog.pg_proc
          where pronamespace = 'public'::pg_catalog.regnamespace
            and proname = 'finalize_ai_polish_request'
        ) <> 2 then
          raise exception 'finalize RPC must have exact V1 and V2 overloads';
        end if;

        select * into v_finalize
        from pg_catalog.pg_proc
        where oid = 'public.finalize_ai_polish_request(uuid,text,boolean,boolean,jsonb,jsonb)'::pg_catalog.regprocedure;
        v_definition := pg_catalog.lower(
          pg_catalog.pg_get_functiondef(v_finalize.oid)
        );

        if not v_finalize.prosecdef
           or v_finalize.provolatile is distinct from 'v'
           or v_finalize.proconfig is distinct from array['search_path=""']::text[]
           or v_finalize.pronargdefaults <> 3
           or pg_catalog.pg_get_function_identity_arguments(v_finalize.oid)
             is distinct from 'p_reservation_id uuid, p_status text, p_quota_charged boolean, p_provider_billable boolean, p_usage jsonb, p_metadata jsonb'
           or pg_catalog.pg_get_function_result(v_finalize.oid) is distinct from 'jsonb' then
          raise exception 'finalize RPC definition drifted';
        end if;

        select * into v_finalize_v2
        from pg_catalog.pg_proc
        where oid = 'public.finalize_ai_polish_request(uuid,text,boolean,boolean,jsonb,jsonb,text)'::pg_catalog.regprocedure;
        if not v_finalize_v2.prosecdef
           or v_finalize_v2.proconfig is distinct from array['search_path=""']::text[]
           or v_finalize_v2.pronargdefaults <> 0
           or pg_catalog.pg_get_function_identity_arguments(v_finalize_v2.oid)
             is distinct from 'p_reservation_id uuid, p_status text, p_quota_charged boolean, p_provider_billable boolean, p_usage jsonb, p_metadata jsonb, p_settlement_contract text'
           or not pg_catalog.has_function_privilege(
             'service_role', v_finalize_v2.oid, 'EXECUTE'
           )
           or pg_catalog.has_function_privilege('anon', v_finalize_v2.oid, 'EXECUTE')
           or pg_catalog.has_function_privilege(
             'authenticated', v_finalize_v2.oid, 'EXECUTE'
           )
           or exists (
             select 1
             from pg_catalog.aclexplode(v_finalize_v2.proacl)
             where grantee = 0 and privilege_type = 'EXECUTE'
           ) then
          raise exception 'audited V2 finalize RPC drifted';
        end if;

        if not pg_catalog.has_function_privilege(
             'service_role', v_finalize.oid, 'EXECUTE'
           )
           or pg_catalog.has_function_privilege('anon', v_finalize.oid, 'EXECUTE')
           or pg_catalog.has_function_privilege(
             'authenticated', v_finalize.oid, 'EXECUTE'
           )
           or exists (
             select 1
             from pg_catalog.aclexplode(v_finalize.proacl)
             where grantee = 0
           ) then
          raise exception 'finalize RPC ACL drifted';
        end if;

        select * into strict v_internal
        from pg_catalog.pg_proc
        where oid = 'public.finalize_ai_polish_request_internal(uuid,text,boolean,boolean,jsonb,jsonb)'::pg_catalog.regprocedure;
        select * into strict v_derive
        from pg_catalog.pg_proc
        where oid = 'public.derive_ai_polish_v2_settlement(uuid)'::pg_catalog.regprocedure;

        if pg_catalog.has_function_privilege(
             'service_role', v_internal.oid, 'EXECUTE'
           )
           or pg_catalog.has_function_privilege('anon', v_internal.oid, 'EXECUTE')
           or pg_catalog.has_function_privilege(
             'authenticated', v_internal.oid, 'EXECUTE'
           )
           or exists (
             select 1 from pg_catalog.aclexplode(v_internal.proacl)
             where grantee = 0 and privilege_type = 'EXECUTE'
           ) then
          raise exception 'internal finalize primitive is executable';
        end if;

        if pg_catalog.has_function_privilege(
             'service_role', v_derive.oid, 'EXECUTE'
           )
           or pg_catalog.has_function_privilege('anon', v_derive.oid, 'EXECUTE')
           or pg_catalog.has_function_privilege(
             'authenticated', v_derive.oid, 'EXECUTE'
           )
           or exists (
             select 1 from pg_catalog.aclexplode(v_derive.proacl)
             where grantee = 0 and privilege_type = 'EXECUTE'
           ) then
          raise exception 'settlement derivation helper is executable';
        end if;

        if v_definition !~
             'from public[.]ai_request_ledger[[:space:]]+where reservation_id = p_reservation_id[[:space:]]+for update'
           or v_definition ~
             'from public[.]ai_provider_attempt_ledger[[:space:]]+where reservation_id = p_reservation_id[[:space:]]+order by attempt_no[[:space:]]+for update' then
          raise exception 'finalize parent-only serialization boundary drifted';
        end if;
      end
      $assertions$;
    `);
  });

  it("finalizes V1 and completed V2 as SELECT-only attempt-ledger service_role", async () => {
    const v1User = await harness.makeUser("finalize-select-only-v1");
    const v1Reserve = await tryReserve(service, v1User.id);
    expect(v1Reserve.ok).toBe(true);
    const v1ReservationId = (v1Reserve as { reservationId: string }).reservationId;

    await harness.activateFreshRouteFixture();
    const v2 = await started("finalize-select-only-v2");
    runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      begin;
      revoke insert, update, delete, truncate on public.ai_provider_attempt_ledger
        from service_role;
      set local role service_role;

      do $assertions$
      declare
        v_result jsonb;
      begin
        if not pg_catalog.has_table_privilege(
             current_user, 'public.ai_provider_attempt_ledger', 'SELECT'
           )
           or pg_catalog.has_table_privilege(
             current_user, 'public.ai_provider_attempt_ledger', 'INSERT'
           )
           or pg_catalog.has_table_privilege(
             current_user, 'public.ai_provider_attempt_ledger', 'UPDATE'
           )
           or pg_catalog.has_table_privilege(
             current_user, 'public.ai_provider_attempt_ledger', 'DELETE'
           )
           or pg_catalog.has_table_privilege(
             current_user, 'public.ai_provider_attempt_ledger', 'TRUNCATE'
           )
           or exists (
             select 1
             from pg_catalog.pg_attribute
             where attrelid = 'public.ai_provider_attempt_ledger'::pg_catalog.regclass
               and attnum > 0
               and not attisdropped
               and pg_catalog.has_column_privilege(
                 current_user,
                 'public.ai_provider_attempt_ledger',
                 attname,
                 'UPDATE'
               )
           ) then
          raise exception 'attempt ledger is not SELECT-only for service_role';
        end if;

        begin
          perform 1
          from public.ai_provider_attempt_ledger
          where attempt_id = '${v2.attempt.attemptId}'::uuid
          for update;
          raise exception 'service_role unexpectedly acquired an attempt row lock';
        exception
          when insufficient_privilege then null;
        end;

        begin
          update public.ai_provider_attempt_ledger
          set attempt_id = attempt_id
          where attempt_id = '${v2.attempt.attemptId}'::uuid;
          raise exception 'service_role unexpectedly updated an attempt directly';
        exception
          when insufficient_privilege then null;
        end;

        begin
          delete from public.ai_provider_attempt_ledger
          where attempt_id = '${v2.attempt.attemptId}'::uuid;
          raise exception 'service_role unexpectedly deleted an attempt directly';
        exception
          when insufficient_privilege then null;
        end;

        begin
          insert into public.ai_provider_attempt_ledger
          select attempt.*
          from public.ai_provider_attempt_ledger as attempt
          where false;
          raise exception 'service_role unexpectedly inserted an attempt directly';
        exception
          when insufficient_privilege then null;
        end;

        begin
          truncate table public.ai_provider_attempt_ledger;
          raise exception 'service_role unexpectedly truncated attempts directly';
        exception
          when insufficient_privilege then null;
        end;

        select public.finalize_ai_polish_request(
          '${v1ReservationId}'::uuid,
          'failed_upstream',
          false,
          true,
          '{"input_cached_tokens":1,"input_uncached_tokens":2,"output_tokens":3,"usage_complete":true}'::jsonb,
          '{}'::jsonb
        ) into v_result;
        if not coalesce((v_result ->> 'ok')::boolean, false)
           or coalesce((v_result ->> 'alreadyFinalized')::boolean, true) then
          raise exception 'SELECT-only V1 finalize failed: %', v_result;
        end if;

        select public.complete_ai_polish_provider_attempt(
          '${v2.attempt.attemptId}'::uuid,
          'succeeded',
          true,
          false,
          true,
          ${jsonbSql(observedUsage())},
          ${jsonbSql(routeObservation())},
          ${jsonbSql(costObservation())},
          ${jsonbSql(attemptMetadata())}
        ) into v_result;
        if not coalesce((v_result ->> 'ok')::boolean, false)
           or coalesce((v_result ->> 'alreadyCompleted')::boolean, true) then
          raise exception 'SELECT-only V2 completion failed: %', v_result;
        end if;

        select public.finalize_ai_polish_request(
          '${v2.reservation.reservationId}'::uuid,
          'succeeded',
          true,
          true,
          null,
          '{"usage_schema_version":"attempt_v2"}'::jsonb,
          'durable_cancellation_sequence_v1'
        ) into v_result;
        if not coalesce((v_result ->> 'ok')::boolean, false)
           or coalesce((v_result ->> 'alreadyFinalized')::boolean, true) then
          raise exception 'SELECT-only V2 finalize failed: %', v_result;
        end if;
      end
      $assertions$;

      reset role;
      rollback;
    `);
  });

  it("returns exact NOT_FOUND for a random reservation UUID without touching any settlement table", async () => {
    const before = await mutableSettlementTablesSnapshot();
    expect(await harness.finalize(randomUUID())).toEqual({
      ok: false,
      reason: "NOT_FOUND",
    });
    expect(await mutableSettlementTablesSnapshot()).toEqual(before);
  });

  it("serializes the profile-daily empty preflight against concurrent writers", async () => {
    const migrationPath = fileURLToPath(
      new URL(
        "../../../supabase/migrations/20260824000000_complete_ai_polish_provider_attempt.sql",
        import.meta.url,
      ),
    );
    const productionSql = readFileSync(migrationPath, "utf8");
    expect(() => validateProfileUsageExpansionPrefix(productionSql)).not.toThrow();

    const suffix = randomUUID().replaceAll("-", "");
    const writerFirstTable = `db010_pf_w_${suffix}`;
    const writerFirstFunction = `${writerFirstTable}_fn`;
    const writerFirstConstraint = `${writerFirstTable}_nonnegative`;
    const migrationFirstTable = `db010_pf_m_${suffix}`;
    const migrationFirstFunction = `${migrationFirstTable}_fn`;
    const migrationFirstConstraint = `${migrationFirstTable}_nonnegative`;

    const createDisposableTable = (tableName: string) => {
      runOwnerSql(String.raw`
        \set ON_ERROR_STOP on
        create table public.${tableName} (id integer primary key);
      `);
    };
    const cleanupDisposable = (tableName: string, functionName: string) => {
      runOwnerSql(String.raw`
        \set ON_ERROR_STOP on
        drop function if exists public.${functionName}();
        drop table if exists public.${tableName};
      `);
    };
    const replaySql = (options: {
      tableName: string;
      functionName: string;
      constraintName: string;
      beforeLockMarker?: string;
      afterDdlMarker?: string;
      holdAfterDdl?: boolean;
    }) => String.raw`
      \set ON_ERROR_STOP on
      \set VERBOSITY verbose
      begin;
      ${options.beforeLockMarker ? `\\echo ${options.beforeLockMarker}` : ""}
      lock table public.${options.tableName} in access exclusive mode;
      do $preflight$
      begin
        if exists (select 1 from public.${options.tableName}) then
          raise exception 'DB-010 requires an empty ai_profile_usage_daily preflight'
            using errcode = '23514';
        end if;
      end
      $preflight$;
      alter table public.${options.tableName}
        add column provider_report_incomplete_count integer not null default 0,
        add constraint ${options.constraintName}
          check (provider_report_incomplete_count >= 0);
      create function public.${options.functionName}()
      returns integer
      language sql
      set search_path = ''
      as $function$ select 1 $function$;
      ${options.afterDdlMarker ? `\\echo ${options.afterDdlMarker}` : ""}
      ${options.holdAfterDdl ? "" : "commit;"}
    `;

    createDisposableTable(writerFirstTable);
    let writerFirstReleased = false;
    let migrationAfterWriter: BarrierSqlProcess | undefined;
    const writerFirst = startOwnerSqlWithBarrier(
      String.raw`
        \set ON_ERROR_STOP on
        begin;
        insert into public.${writerFirstTable} (id) values (1);
        \echo DB010_WRITER_FIRST_HOLDS
      `,
      "DB010_WRITER_FIRST_HOLDS",
      "commit;\n",
    );
    try {
      await writerFirst.ready;
      migrationAfterWriter = startOwnerSqlWithBarrier(
        replaySql({
          tableName: writerFirstTable,
          functionName: writerFirstFunction,
          constraintName: writerFirstConstraint,
          beforeLockMarker: "DB010_MIGRATION_WAITS_FOR_WRITER",
        }),
        "DB010_MIGRATION_WAITS_FOR_WRITER",
      );
      let migrationSettled = false;
      const migrationResult = migrationAfterWriter.result.then((result) => {
        migrationSettled = true;
        return result;
      });
      await migrationAfterWriter.ready;
      await sleep(LOCK_OBSERVATION_MS);
      expect(migrationSettled).toBe(false);

      writerFirst.release();
      writerFirstReleased = true;
      expect((await writerFirst.result).status).toBe(0);
      const failedMigration = await migrationResult;
      expect(failedMigration.status).not.toBe(0);
      expect(failedMigration.stderr).toContain("23514");

      runOwnerSql(String.raw`
        \set ON_ERROR_STOP on
        do $assertions$
        begin
          if (select count(*) from public.${writerFirstTable}) <> 1
             or exists (
               select 1 from pg_catalog.pg_attribute
               where attrelid = 'public.${writerFirstTable}'::pg_catalog.regclass
                 and attname = 'provider_report_incomplete_count'
                 and not attisdropped
             )
             or exists (
               select 1 from pg_catalog.pg_constraint
               where conrelid = 'public.${writerFirstTable}'::pg_catalog.regclass
                 and conname = '${writerFirstConstraint}'
             )
             or pg_catalog.to_regprocedure(
               'public.${writerFirstFunction}()'
             ) is not null then
            raise exception 'writer-first preflight did not roll back cleanly';
          end if;
        end
        $assertions$;
      `);
    } finally {
      if (!writerFirstReleased) {
        writerFirst.release();
        await writerFirst.result;
      }
      if (migrationAfterWriter) {
        await migrationAfterWriter.result;
      }
      cleanupDisposable(writerFirstTable, writerFirstFunction);
    }

    createDisposableTable(migrationFirstTable);
    let migrationFirstReleased = false;
    let writerAfterMigration: BarrierSqlProcess | undefined;
    const migrationFirst = startOwnerSqlWithBarrier(
      replaySql({
        tableName: migrationFirstTable,
        functionName: migrationFirstFunction,
        constraintName: migrationFirstConstraint,
        afterDdlMarker: "DB010_MIGRATION_FIRST_HOLDS",
        holdAfterDdl: true,
      }),
      "DB010_MIGRATION_FIRST_HOLDS",
      "commit;\n",
    );
    try {
      await migrationFirst.ready;
      writerAfterMigration = startOwnerSqlWithBarrier(
        String.raw`
          \set ON_ERROR_STOP on
          begin;
          \echo DB010_WRITER_WAITS_FOR_MIGRATION
          insert into public.${migrationFirstTable} (id) values (1);
          commit;
        `,
        "DB010_WRITER_WAITS_FOR_MIGRATION",
      );
      let writerSettled = false;
      const writerResult = writerAfterMigration.result.then((result) => {
        writerSettled = true;
        return result;
      });
      await writerAfterMigration.ready;
      await sleep(LOCK_OBSERVATION_MS);
      expect(writerSettled).toBe(false);

      migrationFirst.release();
      migrationFirstReleased = true;
      expect((await migrationFirst.result).status).toBe(0);
      expect((await writerResult).status).toBe(0);

      runOwnerSql(String.raw`
        \set ON_ERROR_STOP on
        do $assertions$
        begin
          if (select count(*) from public.${migrationFirstTable}) <> 1
             or (select provider_report_incomplete_count
                 from public.${migrationFirstTable} where id = 1) <> 0
             or not exists (
               select 1 from pg_catalog.pg_constraint
               where conrelid = 'public.${migrationFirstTable}'::pg_catalog.regclass
                 and conname = '${migrationFirstConstraint}'
             )
             or pg_catalog.to_regprocedure(
               'public.${migrationFirstFunction}()'
             ) is null then
            raise exception 'migration-first DDL boundary did not commit exactly';
          end if;
        end
        $assertions$;
      `);
    } finally {
      if (!migrationFirstReleased) {
        migrationFirst.release();
        await migrationFirst.result;
      }
      if (writerAfterMigration) {
        await writerAfterMigration.result;
      }
      cleanupDisposable(migrationFirstTable, migrationFirstFunction);
    }
  });

  it("preserves canonical V1 usage, metadata, attempt_count, refund, and replay behavior", async () => {
    const user = await harness.makeUser("finalize-v1-regression");
    const reserve = await tryReserve(service, user.id);
    expect(reserve.ok).toBe(true);
    const reservationId = (reserve as { reservationId: string }).reservationId;

    const first = await service.rpc("finalize_ai_polish_request", {
      p_reservation_id: reservationId,
      p_status: "failed_upstream",
      p_quota_charged: false,
      p_provider_billable: true,
      p_usage: {
        input_cached_tokens: 11,
        input_uncached_tokens: 22,
        output_tokens: 33,
        usage_complete: true,
      },
      p_metadata: {
        granularity: "item",
        item_count: 2,
        context_level: 1,
        language: "zh",
        model: "legacy-model",
        prompt_version: "legacy-prompt",
        validator_version: "legacy-validator",
        attempt_count: 7,
        provider_request_id: "legacy-provider-request",
        finish_reason: "stop",
        failure_stage: "provider_http",
        latency_ms: 123,
      },
    });
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({
      ok: true,
      alreadyFinalized: false,
      status: "failed_upstream",
      quotaCharged: false,
    });

    expect(await getLedgerRow(service, reservationId)).toMatchObject({
      route_schema_version: null,
      state: "finalized",
      status: "failed_upstream",
      quota_charged: false,
      provider_billable: true,
      input_cached_tokens: 11,
      input_uncached_tokens: 22,
      output_tokens: 33,
      usage_complete: true,
      granularity: "item",
      item_count: 2,
      context_level: 1,
      language: "zh",
      model: "legacy-model",
      prompt_version: "legacy-prompt",
      validator_version: "legacy-validator",
      attempt_count: 7,
      provider_request_id: "legacy-provider-request",
      finish_reason: "stop",
      failure_stage: "provider_http",
      latency_ms: 123,
    });

    const beforeReplay = {
      request: await getLedgerRow(service, reservationId),
      usage: await getUsageRow(service, user.id),
      global: await getGlobalUsageRow(service),
    };
    const replay = await service.rpc("finalize_ai_polish_request", {
      p_reservation_id: reservationId,
      p_status: "hostile",
      p_quota_charged: true,
      p_provider_billable: false,
      p_usage: "hostile",
      p_metadata: 7,
    });
    expect(replay.error).toBeNull();
    expect(replay.data).toEqual({
      ...first.data,
      alreadyFinalized: true,
    });
    expect({
      request: await getLedgerRow(service, reservationId),
      usage: await getUsageRow(service, user.id),
      global: await getGlobalUsageRow(service),
    }).toEqual(beforeReplay);
  });

  it("preserves unfinished V1 parser and DML database errors without partial mutation", async () => {
    const malformedCases = [
      {
        label: "null-status",
        status: null as unknown as string,
        usage: null,
        metadata: null,
        code: "23514",
      },
      {
        label: "usage-cast",
        status: "succeeded",
        usage: { input_cached_tokens: "not-a-bigint" },
        metadata: null,
        code: "22P02",
      },
      {
        label: "metadata-cast",
        status: "succeeded",
        usage: null,
        metadata: { item_count: "not-an-integer" },
        code: "22P02",
      },
    ];

    for (const entry of malformedCases) {
      const user = await harness.makeUser(`v1-malformed-${entry.label}`);
      const reserve = await tryReserve(service, user.id);
      expect(reserve.ok).toBe(true);
      const reservationId = (reserve as { reservationId: string }).reservationId;
      const before = {
        request: await getLedgerRow(service, reservationId),
        user: await getUsageRow(service, user.id),
        global: await getGlobalUsageRow(service),
      };
      const result = await service.rpc("finalize_ai_polish_request", {
        p_reservation_id: reservationId,
        p_status: entry.status,
        p_quota_charged: true,
        p_provider_billable: true,
        p_usage: entry.usage,
        p_metadata: entry.metadata,
      });
      expect(result.data).toBeNull();
      expect(result.error?.code).toBe(entry.code);
      expect({
        request: await getLedgerRow(service, reservationId),
        user: await getUsageRow(service, user.id),
        global: await getGlobalUsageRow(service),
      }).toEqual(before);
    }

    const overflowUser = await harness.makeUser("v1-dml-overflow");
    const overflowReserve = await tryReserve(service, overflowUser.id);
    expect(overflowReserve.ok).toBe(true);
    const overflowReservationId = (
      overflowReserve as { reservationId: string }
    ).reservationId;
    runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      update public.ai_usage_daily
      set input_cached_tokens = 9223372036854775807
      where user_id = '${overflowUser.id}'::uuid
        and day = (transaction_timestamp() at time zone 'utc')::date;
    `);
    const beforeOverflow = {
      request: await getLedgerRow(service, overflowReservationId),
      user: await getUsageRow(service, overflowUser.id),
      global: await getGlobalUsageRow(service),
    };
    const overflow = await service.rpc("finalize_ai_polish_request", {
      p_reservation_id: overflowReservationId,
      p_status: "succeeded",
      p_quota_charged: true,
      p_provider_billable: true,
      p_usage: {
        input_cached_tokens: 1,
        input_uncached_tokens: 0,
        output_tokens: 0,
        usage_complete: true,
      },
      p_metadata: null,
    });
    expect(overflow.data).toBeNull();
    expect(overflow.error?.code).toBe("22003");
    expect({
      request: await getLedgerRow(service, overflowReservationId),
      user: await getUsageRow(service, overflowUser.id),
      global: await getGlobalUsageRow(service),
    }).toEqual(beforeOverflow);
  });

  it("preserves V1 SQL-null versus JSON payload coercion and ignores selector-like unknown keys", async () => {
    const sqlNullUser = await harness.makeUser("v1-usage-sql-null");
    const sqlNullReserve = await tryReserve(service, sqlNullUser.id);
    expect(sqlNullReserve.ok).toBe(true);
    const sqlNullReservation = (
      sqlNullReserve as { reservationId: string }
    ).reservationId;
    const removeSqlNullDaily = await service
      .from("ai_usage_daily")
      .delete()
      .eq("user_id", sqlNullUser.id);
    expect(removeSqlNullDaily.error).toBeNull();
    const sqlNull = await service.rpc("finalize_ai_polish_request", {
      p_reservation_id: sqlNullReservation,
      p_status: "succeeded",
      p_quota_charged: true,
      p_provider_billable: true,
      p_usage: null,
      p_metadata: { usage_schema_version: "future_v99", unknown: true },
    });
    expect(sqlNull.error).toBeNull();
    expect(sqlNull.data).toMatchObject({ ok: true, alreadyFinalized: false });
    expect(await getLedgerRow(service, sqlNullReservation)).toMatchObject({
      input_cached_tokens: null,
      input_uncached_tokens: null,
      output_tokens: null,
      usage_schema_version: null,
    });
    expect(await getUsageRow(service, sqlNullUser.id)).toBeNull();

    for (const [label, usageSql] of [
      ["json-null", "'null'::jsonb"],
      ["empty-object", "'{}'::jsonb"],
      ["array", "'[]'::jsonb"],
      ["scalar", "'\"scalar\"'::jsonb"],
    ] as const) {
      const user = await harness.makeUser(`v1-usage-${label}`);
      const reserve = await tryReserve(service, user.id);
      expect(reserve.ok).toBe(true);
      const reservationId = (reserve as { reservationId: string }).reservationId;
      const removeDaily = await service
        .from("ai_usage_daily")
        .delete()
        .eq("user_id", user.id);
      expect(removeDaily.error).toBeNull();
      const result = runOwnerSql(String.raw`
        \set ON_ERROR_STOP on
        \pset format unaligned
        \pset tuples_only on
        begin;
        set local role service_role;
        select public.finalize_ai_polish_request(
          '${reservationId}'::uuid,
          'succeeded',
          true,
          true,
          ${usageSql},
          '{"usage_schema_version":"future_v99","unknown":true}'::jsonb
        );
        reset role;
        commit;
      `);
      expect(result.stdout).toContain('"ok": true');
      expect(await getLedgerRow(service, reservationId)).toMatchObject({
        input_cached_tokens: 0,
        input_uncached_tokens: 0,
        output_tokens: 0,
        usage_complete: false,
        usage_schema_version: null,
      });
      expect(await getUsageRow(service, user.id)).toMatchObject({
        request_count: 0,
        input_cached_tokens: 0,
        input_uncached_tokens: 0,
        output_tokens: 0,
      });
    }

    const coercionUser = await harness.makeUser("v1-string-coercion");
    const coercionReserve = await tryReserve(service, coercionUser.id);
    expect(coercionReserve.ok).toBe(true);
    const coercionReservation = (
      coercionReserve as { reservationId: string }
    ).reservationId;
    const coercion = await service.rpc("finalize_ai_polish_request", {
      p_reservation_id: coercionReservation,
      p_status: "succeeded",
      p_quota_charged: true,
      p_provider_billable: true,
      p_usage: {
        input_cached_tokens: "6",
        input_uncached_tokens: "7",
        output_tokens: "8",
        usage_complete: "true",
        unknown: "ignored",
      },
      p_metadata: {
        usage_schema_version: "future_v99",
        item_count: "2",
        context_level: "1",
        attempt_count: "9",
        unknown: "ignored",
      },
    });
    expect(coercion.error).toBeNull();
    expect(await getLedgerRow(service, coercionReservation)).toMatchObject({
      input_cached_tokens: 6,
      input_uncached_tokens: 7,
      output_tokens: 8,
      usage_complete: true,
      item_count: 2,
      context_level: 1,
      attempt_count: 9,
      usage_schema_version: null,
    });
  });

  it("keeps the sole V1 compatibility exception for a child-backed request", async () => {
    const v1User = await harness.makeUser("v1-child-guard");
    const v1Reserve = await tryReserve(service, v1User.id);
    expect(v1Reserve.ok).toBe(true);
    const v1ReservationId = (v1Reserve as { reservationId: string }).reservationId;
    const v2 = await completed("v1-child-guard-donor");
    runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      set session_replication_role = replica;
      update public.ai_provider_attempt_ledger
      set reservation_id = '${v1ReservationId}'::uuid
      where attempt_id = '${v2.attempt.attemptId}'::uuid;
      set session_replication_role = origin;
    `);

    const before = {
      request: await getLedgerRow(service, v1ReservationId),
      user: await getUsageRow(service, v1User.id),
      global: await getGlobalUsageRow(service),
    };
    const result = await service.rpc("finalize_ai_polish_request", {
      p_reservation_id: v1ReservationId,
      p_status: "succeeded",
      p_quota_charged: true,
      p_provider_billable: true,
      p_usage: null,
      p_metadata: null,
    });
    expect(result.error).toBeNull();
    expect(result.data).toEqual({ ok: false, reason: "SERVICE_UNAVAILABLE" });
    expect({
      request: await getLedgerRow(service, v1ReservationId),
      user: await getUsageRow(service, v1User.id),
      global: await getGlobalUsageRow(service),
    }).toEqual(before);
  });

  it("keeps V1 rollover attribution, finalized_at, and replay quota on one transaction clock", async () => {
    const user = await harness.makeUser("v1-transaction-clock-rollover");
    const reserve = await tryReserve(service, user.id);
    expect(reserve.ok).toBe(true);
    const reservationId = (reserve as { reservationId: string }).reservationId;

    runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      begin;
      create temporary table v1_clock_results (
        kind text primary key,
        payload jsonb not null
      ) on commit drop;
      grant select, insert on v1_clock_results to service_role;

      update public.ai_request_ledger
      set reserved_at = (
        (
          (transaction_timestamp() at time zone 'utc')::date - 1
        ) + time '23:59:00'
      ) at time zone 'utc'
      where reservation_id = '${reservationId}'::uuid;

      delete from public.ai_usage_daily
      where user_id = '${user.id}'::uuid;
      insert into public.ai_usage_daily (user_id, day, request_count)
      values (
        '${user.id}'::uuid,
        (transaction_timestamp() at time zone 'utc')::date - 1,
        1
      );

      set local role service_role;
      insert into v1_clock_results (kind, payload)
      select 'first', public.finalize_ai_polish_request(
        '${reservationId}'::uuid,
        'failed_upstream',
        false,
        true,
        '{
          "input_cached_tokens":3,
          "input_uncached_tokens":4,
          "output_tokens":5,
          "usage_complete":true
        }'::jsonb,
        null
      );
      insert into v1_clock_results (kind, payload)
      select 'replay', public.finalize_ai_polish_request(
        '${reservationId}'::uuid,
        'hostile',
        true,
        false,
        '{"hostile":true}'::jsonb,
        '"hostile"'::jsonb
      );
      reset role;

      do $assertions$
      declare
        v_request public.ai_request_ledger%rowtype;
        v_previous public.ai_usage_daily%rowtype;
        v_today public.ai_usage_daily%rowtype;
        v_first jsonb;
        v_replay jsonb;
        v_expected_reset timestamptz;
      begin
        select * into strict v_request
        from public.ai_request_ledger
        where reservation_id = '${reservationId}'::uuid;
        select * into strict v_previous
        from public.ai_usage_daily
        where user_id = '${user.id}'::uuid
          and day = (transaction_timestamp() at time zone 'utc')::date - 1;
        select * into strict v_today
        from public.ai_usage_daily
        where user_id = '${user.id}'::uuid
          and day = (transaction_timestamp() at time zone 'utc')::date;
        select payload into strict v_first
        from v1_clock_results where kind = 'first';
        select payload into strict v_replay
        from v1_clock_results where kind = 'replay';
        v_expected_reset := (
          (transaction_timestamp() at time zone 'utc')::date + 1
        ) at time zone 'utc';

        if v_request.finalized_at is distinct from transaction_timestamp()
           or v_request.state is distinct from 'finalized'
           or v_previous.request_count <> 0
           or v_today.request_count <> 0
           or (v_today.input_cached_tokens, v_today.input_uncached_tokens, v_today.output_tokens)
             is distinct from (3::bigint, 4::bigint, 5::bigint)
           or (v_first ->> 'alreadyFinalized')::boolean is distinct from false
           or (v_replay ->> 'alreadyFinalized')::boolean is distinct from true
           or (v_first -> 'quota' ->> 'resetAt')::timestamptz
             is distinct from v_expected_reset
           or (v_replay -> 'quota' ->> 'resetAt')::timestamptz
             is distinct from v_expected_reset then
          raise exception 'V1 transaction clock or UTC rollover drifted';
        end if;
      end
      $assertions$;
      commit;
    `);
  });

  it("only releases a clean zero-attempt V2 tuple and never manufactures usage", async () => {
    const user = await harness.makeUser("finalize-zero-release");
    const reservation = await harness.reserveV2(user);
    const beforeUsage = await getUsageRow(service, user.id);
    expect(beforeUsage?.request_count).toBe(1);

    expect(
      await harness.finalize(reservation.reservationId, {
        status: "released",
        quotaCharged: false,
        providerBillable: false,
        usage: null,
        metadata: null,
      }),
    ).toMatchObject({
      ok: true,
      alreadyFinalized: false,
      status: "released",
      quotaCharged: false,
    });

    expect(await getLedgerRow(service, reservation.reservationId)).toMatchObject({
      state: "finalized",
      status: "released",
      attempt_count: 0,
      usage_schema_version: null,
      input_cached_tokens: null,
      input_total_tokens: null,
      cost_basis: null,
      billing_currency: null,
    });
    expect((await getUsageRow(service, user.id))?.request_count).toBe(0);
    const profileDaily = await service
      .from("ai_profile_usage_daily")
      .select("*")
      .eq("profile_version_id", harness.fixture.profileVersionId);
    expect(profileDaily.error).toBeNull();
    expect(profileDaily.data).toEqual([]);
  });

  it("fails closed when the public V1 start marker pollutes a zero-child V2 reservation", async () => {
    const user = await harness.makeUser("finalize-zero-v1-marker-pollution");
    const reservation = await harness.reserveV2(user);
    const marked = await service.rpc("mark_ai_polish_provider_started", {
      p_reservation_id: reservation.reservationId,
      p_provider_request_id: null,
    });
    expect(marked.error).toBeNull();
    expect(marked.data).toEqual({ ok: true, attemptCount: 1 });
    expect(await getLedgerRow(service, reservation.reservationId)).toMatchObject({
      route_schema_version: "route_snapshot_v1",
      state: "provider_started",
      attempt_count: 1,
    });

    const before = await fullSettlementSnapshot(
      user.id,
      reservation.reservationId,
    );
    expect(
      await harness.finalize(reservation.reservationId, {
        status: "released",
        quotaCharged: false,
        providerBillable: false,
        usage: null,
        metadata: null,
      }),
    ).toEqual({ ok: false, reason: "SERVICE_UNAVAILABLE" });
    expect(
      await fullSettlementSnapshot(user.id, reservation.reservationId),
    ).toEqual(before);
  });

  it("rejects zero-attempt attempt_v2 and every non-clean legacy tuple without mutation", async () => {
    const cases = [
      {
        label: "attempt-v2",
        options: {},
        expected: "SETTLEMENT_ASSERTION_CONFLICT",
      },
      {
        label: "status",
        options: {
          status: "succeeded",
          quotaCharged: false,
          providerBillable: false,
          metadata: null,
        },
        expected: "SETTLEMENT_ASSERTION_CONFLICT",
      },
      {
        label: "quota",
        options: {
          status: "released",
          quotaCharged: true,
          providerBillable: false,
          metadata: null,
        },
        expected: "SETTLEMENT_ASSERTION_CONFLICT",
      },
      {
        label: "billable",
        options: {
          status: "released",
          quotaCharged: false,
          providerBillable: null,
          metadata: null,
        },
        expected: "SETTLEMENT_ASSERTION_CONFLICT",
      },
      {
        label: "usage-object",
        options: {
          status: "released",
          quotaCharged: false,
          providerBillable: false,
          usage: {},
          metadata: null,
        },
        expected: "INTERNAL_ERROR",
      },
    ];

    for (const entry of cases) {
      const user = await harness.makeUser(`finalize-zero-${entry.label}`);
      const reservation = await harness.reserveV2(user);
      const before = {
        request: await getLedgerRow(service, reservation.reservationId),
        usage: await getUsageRow(service, user.id),
      };
      expect(
        await harness.finalize(reservation.reservationId, entry.options),
      ).toEqual({ ok: false, reason: entry.expected });
      expect({
        request: await getLedgerRow(service, reservation.reservationId),
        usage: await getUsageRow(service, user.id),
      }).toEqual(before);
    }
  });

  it("requires attempt_v2 with absent usage once a child exists", async () => {
    const { user, reservation, attempt } = await completed(
      "finalize-source-guards",
    );
    const before = {
      request: await getLedgerRow(service, reservation.reservationId),
      usage: await getUsageRow(service, user.id),
    };

    expect(
      await harness.finalize(reservation.reservationId, { metadata: null }),
    ).toEqual({ ok: false, reason: "ATTEMPT_USAGE_SOURCE_REQUIRED" });
    expect(
      await harness.finalize(reservation.reservationId, {
        metadata: { usage_schema_version: "legacy_v1" },
      }),
    ).toEqual({ ok: false, reason: "ATTEMPT_USAGE_SOURCE_REQUIRED" });
    expect(
      await harness.finalize(reservation.reservationId, {
        usage: observedUsage(),
      }),
    ).toEqual({ ok: false, reason: "AMBIGUOUS_USAGE_SOURCE" });
    for (const metadata of [
      { usage_schema_version: "unknown" },
      { usage_schema_version: 1 },
      [],
      "attempt_v2",
      1,
    ]) {
      expect(
        await harness.finalize(reservation.reservationId, { metadata }),
      ).toEqual({ ok: false, reason: "INTERNAL_ERROR" });
    }

    expect({
      request: await getLedgerRow(service, reservation.reservationId),
      usage: await getUsageRow(service, user.id),
    }).toEqual(before);
    const child = await service
      .from("ai_provider_attempt_ledger")
      .select("status")
      .eq("attempt_id", attempt.attemptId)
      .single();
    expect(child.data?.status).toBe("succeeded");
  });

  it("distinguishes V2 SQL NULL, JSON null, object, array, and scalar usage through raw psql", async () => {
    const cases = [
      { label: "sql-null", usageSql: "null", accepted: true },
      { label: "json-null", usageSql: "'null'::jsonb", accepted: true },
      { label: "empty-object", usageSql: "'{}'::jsonb", accepted: false },
      { label: "array", usageSql: "'[]'::jsonb", accepted: false },
      {
        label: "scalar",
        usageSql: `'"scalar"'::jsonb`,
        accepted: false,
      },
    ] as const;

    for (const entry of cases) {
      const value = await completed(`finalize-v2-raw-${entry.label}`);
      const before = await fullSettlementSnapshot(
        value.user.id,
        value.reservation.reservationId,
      );
      const result = invokeRawFinalize(
        value.reservation.reservationId,
        entry.usageSql,
      );
      if (entry.accepted) {
        expect(result).toMatchObject({
          ok: true,
          alreadyFinalized: false,
          status: "succeeded",
          quotaCharged: true,
        });
        expect(
          await getLedgerRow(service, value.reservation.reservationId),
        ).toMatchObject({
          state: "finalized",
          status: "succeeded",
          usage_schema_version: "request_usage_aggregate_v2",
          attempt_count: 1,
        });
      } else {
        expect(result).toEqual({
          ok: false,
          reason: "AMBIGUOUS_USAGE_SOURCE",
        });
        expect(
          await fullSettlementSnapshot(
            value.user.id,
            value.reservation.reservationId,
          ),
        ).toEqual(before);
      }
    }
  });

  it("classifies nullable quota and unsafe V2 metadata casts as caller faults before daily mutation", async () => {
    const cases: Array<{
      label: string;
      quotaCharged: boolean | null;
      metadata: Record<string, unknown>;
    }> = [
      {
        label: "quota-null",
        quotaCharged: null,
        metadata: { usage_schema_version: "attempt_v2" },
      },
      {
        label: "item-string",
        quotaCharged: true,
        metadata: { usage_schema_version: "attempt_v2", item_count: "1" },
      },
      {
        label: "item-negative",
        quotaCharged: true,
        metadata: { usage_schema_version: "attempt_v2", item_count: -1 },
      },
      {
        label: "item-fraction",
        quotaCharged: true,
        metadata: { usage_schema_version: "attempt_v2", item_count: 1.5 },
      },
      {
        label: "item-overflow",
        quotaCharged: true,
        metadata: {
          usage_schema_version: "attempt_v2",
          item_count: 2_147_483_648,
        },
      },
      {
        label: "context-string",
        quotaCharged: true,
        metadata: { usage_schema_version: "attempt_v2", context_level: "1" },
      },
      {
        label: "context-negative",
        quotaCharged: true,
        metadata: { usage_schema_version: "attempt_v2", context_level: -1 },
      },
      {
        label: "context-high",
        quotaCharged: true,
        metadata: { usage_schema_version: "attempt_v2", context_level: 3 },
      },
      {
        label: "context-object",
        quotaCharged: true,
        metadata: { usage_schema_version: "attempt_v2", context_level: {} },
      },
      {
        label: "granularity-number",
        quotaCharged: true,
        metadata: { usage_schema_version: "attempt_v2", granularity: 1 },
      },
      {
        label: "granularity-domain",
        quotaCharged: true,
        metadata: {
          usage_schema_version: "attempt_v2",
          granularity: "paragraph",
        },
      },
      {
        label: "language-number",
        quotaCharged: true,
        metadata: { usage_schema_version: "attempt_v2", language: 1 },
      },
      {
        label: "language-domain",
        quotaCharged: true,
        metadata: { usage_schema_version: "attempt_v2", language: "fr" },
      },
      {
        label: "prompt-object",
        quotaCharged: true,
        metadata: { usage_schema_version: "attempt_v2", prompt_version: {} },
      },
      {
        label: "validator-array",
        quotaCharged: true,
        metadata: { usage_schema_version: "attempt_v2", validator_version: [] },
      },
    ];

    await harness.activateFreshRouteFixture();
    for (const entry of cases) {
      const value = await completed(`v2-caller-${entry.label}`);
      const before = await settlementSnapshot(
        value.user.id,
        value.reservation.reservationId,
      );
      expect(before.profile).toEqual([]);
      const result = await service.rpc("finalize_ai_polish_request", {
        p_reservation_id: value.reservation.reservationId,
        p_status: "succeeded",
        p_quota_charged: entry.quotaCharged as boolean,
        p_provider_billable: true,
        p_usage: null,
        p_metadata: entry.metadata,
        p_settlement_contract: "durable_cancellation_sequence_v1",
      });
      expect(result.error).toBeNull();
      expect(result.data).toEqual({
        ok: false,
        reason:
          entry.quotaCharged !== true
            ? "SETTLEMENT_ASSERTION_CONFLICT"
            : "INTERNAL_ERROR",
      });
      expect(
        await settlementSnapshot(
          value.user.id,
          value.reservation.reservationId,
        ),
      ).toEqual(before);
    }

    const valid = await completed("v2-caller-metadata-boundaries");
    expect(
      await harness.finalize(valid.reservation.reservationId, {
        metadata: {
          usage_schema_version: "attempt_v2",
          item_count: 2_147_483_647,
          context_level: 2,
          granularity: null,
          language: null,
          prompt_version: null,
          validator_version: null,
        },
      }),
    ).toMatchObject({ ok: true, alreadyFinalized: false });
    expect(await getLedgerRow(service, valid.reservation.reservationId)).toMatchObject({
      item_count: 2_147_483_647,
      context_level: 2,
      granularity: null,
      language: null,
      prompt_version: null,
      validator_version: null,
    });

    const validStrings = await completed("v2-caller-metadata-strings");
    expect(
      await harness.finalize(validStrings.reservation.reservationId, {
        metadata: {
          usage_schema_version: "attempt_v2",
          granularity: "group",
          language: "en",
          prompt_version: "",
          validator_version: "",
        },
      }),
    ).toMatchObject({ ok: true, alreadyFinalized: false });
    expect(
      await getLedgerRow(service, validStrings.reservation.reservationId),
    ).toMatchObject({
      granularity: "group",
      language: "en",
      prompt_version: "",
      validator_version: "",
    });
    await harness.activateFreshRouteFixture();
  });

  it("rejects an in-progress attempt and parent count drift before settlement", async () => {
    const inProgress = await started("finalize-in-progress");
    expect(
      await harness.finalize(inProgress.reservation.reservationId),
    ).toEqual({ ok: false, reason: "ATTEMPT_IN_PROGRESS" });
    expect(await getLedgerRow(service, inProgress.reservation.reservationId)).toMatchObject({
      state: "reserved",
      attempt_count: 1,
    });

    const drift = await completed("finalize-count-drift");
    const update = await service
      .from("ai_request_ledger")
      .update({ attempt_count: 2 })
      .eq("reservation_id", drift.reservation.reservationId);
    expect(update.error).toBeNull();
    expect(await harness.finalize(drift.reservation.reservationId)).toEqual({
      ok: false,
      reason: "TRANSMISSION_UNKNOWN_HELD",
      detail: "INVALID_ATTEMPT_SEQUENCE",
    });
    expect(await getLedgerRow(service, drift.reservation.reservationId)).toMatchObject({
      state: "reserved",
      attempt_count: 2,
    });
  });

  it("rejects an owner-corrupted terminal child set containing only attempt two", async () => {
    const value = await completed("finalize-invalid-child-set-two");
    runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      set session_replication_role = replica;
      update public.ai_provider_attempt_ledger
      set attempt_no = 2
      where attempt_id = '${value.attempt.attemptId}'::uuid;
      set session_replication_role = origin;
    `);
    const before = await fullSettlementSnapshot(
      value.user.id,
      value.reservation.reservationId,
    );
    expect(before.attempts).toHaveLength(1);
    expect(before.attempts?.[0]).toMatchObject({ attempt_no: 2 });

    expect(await harness.finalize(value.reservation.reservationId)).toEqual({
      ok: false,
      reason: "TRANSMISSION_UNKNOWN_HELD",
      detail: "INVALID_ATTEMPT_SEQUENCE",
    });
    expect(
      await fullSettlementSnapshot(
        value.user.id,
        value.reservation.reservationId,
      ),
    ).toEqual(before);
  });

  it("rejects owner-corrupted parent and attempt disclosure snapshots before settlement", async () => {
    const value = await completed("finalize-disclosure-corruption");
    const corruptedDisclosure = "owner-corrupted.disclosure";
    runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      set session_replication_role = replica;
      update public.ai_request_ledger
      set display_disclosure_key = '${corruptedDisclosure}'
      where reservation_id = '${value.reservation.reservationId}'::uuid;
      update public.ai_provider_attempt_ledger
      set display_disclosure_key = '${corruptedDisclosure}'
      where attempt_id = '${value.attempt.attemptId}'::uuid;
      set session_replication_role = origin;
    `);

    const currentProfile = await service
      .from("ai_provider_profile_versions")
      .select("display_disclosure_key")
      .eq("id", harness.fixture.profileVersionId)
      .single();
    expect(currentProfile.error).toBeNull();
    expect(currentProfile.data?.display_disclosure_key).toBe(
      harness.fixture.displayDisclosureKey,
    );

    const before = {
      settlement: await settlementSnapshot(
        value.user.id,
        value.reservation.reservationId,
      ),
      attempt: await service
        .from("ai_provider_attempt_ledger")
        .select("*")
        .eq("attempt_id", value.attempt.attemptId)
        .single(),
      rate: await service
        .from("ai_rate_minutes")
        .select("*")
        .eq("user_id", value.user.id)
        .order("minute_bucket"),
      profile: currentProfile,
    };
    expect(before.attempt.error).toBeNull();
    expect(before.rate.error).toBeNull();
    expect(before.settlement.request).toMatchObject({
      display_disclosure_key: corruptedDisclosure,
    });
    expect(before.attempt.data).toMatchObject({
      display_disclosure_key: corruptedDisclosure,
    });

    expect(await harness.finalize(value.reservation.reservationId)).toEqual({
      ok: false,
      reason: "SERVICE_UNAVAILABLE",
    });
    expect({
      settlement: await settlementSnapshot(
        value.user.id,
        value.reservation.reservationId,
      ),
      attempt: await service
        .from("ai_provider_attempt_ledger")
        .select("*")
        .eq("attempt_id", value.attempt.attemptId)
        .single(),
      rate: await service
        .from("ai_rate_minutes")
        .select("*")
        .eq("user_id", value.user.id)
        .order("minute_bucket"),
      profile: await service
        .from("ai_provider_profile_versions")
        .select("display_disclosure_key")
        .eq("id", harness.fixture.profileVersionId)
        .single(),
    }).toEqual(before);
  });

  it("settles one reported attempt into V2 and legacy ledgers exactly once", async () => {
    const { user, reservation } = await completed("finalize-one-reported");
    const usageBefore = await getUsageRow(service, user.id);
    const globalBefore = await getGlobalUsageRow(service);

    const result = await harness.finalize(reservation.reservationId);
    expect(result).toMatchObject({
      ok: true,
      alreadyFinalized: false,
      status: "succeeded",
      quotaCharged: true,
    });
    expect(await getLedgerRow(service, reservation.reservationId)).toMatchObject({
      state: "finalized",
      status: "succeeded",
      usage_schema_version: "request_usage_aggregate_v2",
      input_total_tokens: 100,
      input_cache_read_tokens: 60,
      input_cache_write_tokens: 10,
      input_standard_tokens: 30,
      output_tokens: 20,
      reasoning_tokens: 5,
      cache_usage_reporting: "reported",
      incomplete_fields: [],
      usage_complete: true,
      provider_billable: true,
      cost_basis: "frozen_price_version_v1",
      billing_currency: "CNY",
      known_estimated_cost_nanos: 1234,
      estimated_cost_nanos: 1234,
      provider_reported_currency: null,
      provider_reported_cost_nanos: null,
      cost_reconciliation_status: "not_available",
      input_cached_tokens: 60,
      input_uncached_tokens: 40,
    });

    expect(await getUsageRow(service, user.id)).toMatchObject({
      request_count: usageBefore!.request_count,
      input_cached_tokens: usageBefore!.input_cached_tokens + 60,
      input_uncached_tokens: usageBefore!.input_uncached_tokens + 40,
      output_tokens: usageBefore!.output_tokens + 20,
    });
    expect(await getGlobalUsageRow(service)).toMatchObject({
      provider_started_count: globalBefore!.provider_started_count,
      input_cached_tokens: globalBefore!.input_cached_tokens + 60,
      input_uncached_tokens: globalBefore!.input_uncached_tokens + 40,
      output_tokens: globalBefore!.output_tokens + 20,
    });
    const profile = await service
      .from("ai_profile_usage_daily")
      .select("*")
      .eq("profile_version_id", harness.fixture.profileVersionId)
      .eq("billing_currency", "CNY")
      .single();
    expect(profile.error).toBeNull();
    expect(profile.data).toMatchObject({
      request_count: 1,
      usage_incomplete_count: 0,
      cost_incomplete_count: 0,
      provider_report_incomplete_count: 1,
      input_total_tokens: 100,
      input_cache_read_tokens: 60,
      input_cache_write_tokens: 10,
      input_standard_tokens: 30,
      output_tokens: 20,
      reasoning_tokens: 5,
      known_estimated_cost_nanos: 1234,
      estimated_cost_nanos: 1234,
      provider_reported_cost_nanos: null,
    });

    const beforeReplay = {
      request: await getLedgerRow(service, reservation.reservationId),
      usage: await getUsageRow(service, user.id),
      global: await getGlobalUsageRow(service),
      profile: profile.data,
    };
    expect(
      await harness.finalize(reservation.reservationId, {
        status: "released",
        quotaCharged: false,
        providerBillable: false,
        usage: { hostile: true },
        metadata: 9,
      }),
    ).toEqual({ ok: false, reason: "FINALIZE_CONFLICT" });
    const profileAfter = await service
      .from("ai_profile_usage_daily")
      .select("*")
      .eq("profile_version_id", harness.fixture.profileVersionId)
      .eq("billing_currency", "CNY")
      .single();
    expect({
      request: await getLedgerRow(service, reservation.reservationId),
      usage: await getUsageRow(service, user.id),
      global: await getGlobalUsageRow(service),
      profile: profileAfter.data,
    }).toEqual(beforeReplay);
  });

  it("keeps mixed cache-write and reasoning unknown while preserving core and legacy totals", async () => {
    const user = await harness.makeUser("finalize-mixed-cache");
    const reservation = await harness.reserveV2(user);
    const first = await harness.startAttempt(reservation.reservationId, 1);
    await harness.complete(
      completePayload(first.attemptId, {
        p_status: "failed_upstream",
        p_retry_eligible: true,
      }),
    );
    const second = await harness.startAttempt(reservation.reservationId, 2);
    await harness.complete(
      completePayload(second.attemptId, {
        p_usage: observedUsage({
          input_total_tokens: 60,
          input_cache_read_tokens: 20,
          input_cache_write_tokens: null,
          input_standard_tokens: 40,
          output_tokens: 10,
          reasoning_tokens: null,
          cache_usage_reporting: "unavailable",
        }),
        p_cost: costObservation({
          estimated_cost_nanos: "100",
        }),
        p_metadata: attemptMetadata({ latency_ms: 20 }),
      }),
    );

    expect(await harness.finalize(reservation.reservationId)).toMatchObject({
      ok: true,
      alreadyFinalized: false,
    });
    expect(await getLedgerRow(service, reservation.reservationId)).toMatchObject({
      input_total_tokens: 160,
      input_cache_read_tokens: 80,
      input_cache_write_tokens: null,
      input_standard_tokens: 70,
      output_tokens: 30,
      reasoning_tokens: null,
      cache_usage_reporting: "unavailable",
      incomplete_fields: ["input_cache_write", "reasoning"],
      usage_complete: true,
      input_cached_tokens: 80,
      input_uncached_tokens: 80,
      known_estimated_cost_nanos: 1334,
      estimated_cost_nanos: 1334,
    });
    expect(await getUsageRow(service, user.id)).toMatchObject({
      input_cached_tokens: 80,
      input_uncached_tokens: 80,
      output_tokens: 30,
    });
    const global = await getGlobalUsageRow(service);
    expect(global).toMatchObject({
      input_cached_tokens: expect.any(Number),
      input_uncached_tokens: expect.any(Number),
    });
    const profile = await service
      .from("ai_profile_usage_daily")
      .select("input_total_tokens,input_cache_read_tokens,input_cache_write_tokens,input_standard_tokens,output_tokens,reasoning_tokens")
      .eq("profile_version_id", harness.fixture.profileVersionId)
      .eq("billing_currency", "CNY")
      .single();
    expect(profile.data).toMatchObject({
      input_total_tokens: expect.any(Number),
      input_cache_write_tokens: null,
      reasoning_tokens: null,
    });
  });

  it("preserves observed lower bounds beside unavailable or incomplete usage", async () => {
    for (const [label, secondUsage] of [
      ["unavailable", null],
      ["observed-incomplete", observedUsage({ usage_complete: false })],
    ] as const) {
      const user = await harness.makeUser(`finalize-lower-bound-${label}`);
      const reservation = await harness.reserveV2(user);
      const first = await harness.startAttempt(reservation.reservationId, 1);
      await harness.complete(
        completePayload(first.attemptId, {
          p_status: "failed_upstream",
          p_retry_eligible: true,
        }),
      );
      const second = await harness.startAttempt(reservation.reservationId, 2);
      await harness.complete(
        completePayload(second.attemptId, {
          p_status: "failed_upstream",
          p_provider_billable: secondUsage === null ? false : true,
          p_usage: secondUsage,
          p_cost:
            secondUsage === null
              ? costObservation({
                  estimated_currency: null,
                  estimated_cost_nanos: null,
                  reconciliation_status: "incomplete_usage",
                })
              : costObservation(),
          p_metadata: attemptMetadata({ finish_reason: null }),
        }),
      );
      expect(
        await harness.finalize(reservation.reservationId, {
          status: "failed_upstream",
          quotaCharged: false,
          providerBillable: true,
        }),
      ).toMatchObject({ ok: true });
      const row = await getLedgerRow(service, reservation.reservationId);
      expect(row).toMatchObject({
        input_total_tokens: secondUsage === null ? 100 : 200,
        input_cache_read_tokens: secondUsage === null ? 60 : 120,
        output_tokens: secondUsage === null ? 20 : 40,
        usage_complete: false,
      });
      expect(row!.incomplete_fields).toContain("attempt_usage");
    }
  });

  it("derives true, false, and null billability and rejects caller mismatches", async () => {
    const trueCase = await completed("finalize-billable-true");
    expect(
      await harness.finalize(trueCase.reservation.reservationId, {
        providerBillable: false,
      }),
    ).toEqual({ ok: false, reason: "SETTLEMENT_ASSERTION_CONFLICT" });
    expect(await getLedgerRow(service, trueCase.reservation.reservationId)).toMatchObject({
      state: "reserved",
    });

    const falseCase = await completed("finalize-billable-false", {
      p_status: "canceled",
      p_transmitted: false,
      p_provider_billable: false,
      p_usage: null,
      p_cost: costObservation({
        estimated_currency: null,
        estimated_cost_nanos: null,
        reconciliation_status: "incomplete_usage",
      }),
      p_metadata: attemptMetadata({ finish_reason: null }),
    });
    expect(
      await harness.finalize(falseCase.reservation.reservationId, {
        status: "canceled",
        quotaCharged: false,
        providerBillable: false,
      }),
    ).toMatchObject({ ok: true });
    expect(await getLedgerRow(service, falseCase.reservation.reservationId)).toMatchObject({
      provider_billable: false,
      known_estimated_cost_nanos: null,
      estimated_cost_nanos: null,
      billing_currency: "CNY",
      cost_reconciliation_status: "not_available",
    });
    expect(
      (await getLedgerRow(service, falseCase.reservation.reservationId))!
        .incomplete_fields,
    ).not.toContain("estimated_cost");

    const nullCase = await completed("finalize-billable-null", {
      p_provider_billable: null,
      p_cost: costObservation({
        estimated_currency: null,
        estimated_cost_nanos: null,
        reconciliation_status: "incomplete_usage",
      }),
    });
    expect(
      await harness.finalize(nullCase.reservation.reservationId, {
        providerBillable: null,
      }),
    ).toMatchObject({ ok: true });
    expect(await getLedgerRow(service, nullCase.reservation.reservationId)).toMatchObject({
      provider_billable: null,
      estimated_cost_nanos: null,
      cost_reconciliation_status: "incomplete_usage",
    });
    expect(
      (await getLedgerRow(service, nullCase.reservation.reservationId))!
        .incomplete_fields,
    ).toEqual(expect.arrayContaining(["provider_billable", "estimated_cost"]));
  });

  it("rejects abandoned settlement through the audited public signature", async () => {
    const direct = await completed("finalize-abandoned-direct");
    const directBefore = await settlementSnapshot(
      direct.user.id,
      direct.reservation.reservationId,
    );
    expect(
      await harness.finalize(direct.reservation.reservationId, {
        status: "abandoned",
        quotaCharged: false,
        providerBillable: true,
      }),
    ).toEqual({ ok: false, reason: "AUDITED_SETTLEMENT_REJECTED" });
    expect(
      await settlementSnapshot(direct.user.id, direct.reservation.reservationId),
    ).toEqual(directBefore);
  });

  it("returns exact finalized readback before unknown selector, scalar metadata, usage, or billability parsing", async () => {
    const { user, reservation } = await completed("finalize-hostile-replay");
    const first = await harness.finalize(reservation.reservationId);
    expect(first).toMatchObject({ ok: true, alreadyFinalized: false });
    const before = {
      request: await getLedgerRow(service, reservation.reservationId),
      usage: await getUsageRow(service, user.id),
      global: await getGlobalUsageRow(service),
      profile: await service
        .from("ai_profile_usage_daily")
        .select("*")
        .eq("profile_version_id", harness.fixture.profileVersionId),
    };

    expect(
      await harness.finalize(reservation.reservationId, {
        status: "abandoned",
        quotaCharged: false,
        providerBillable: false,
        usage: { hostile: true },
        metadata: "unknown-source",
      }),
    ).toEqual({ ok: false, reason: "FINALIZE_CONFLICT" });
    expect({
      request: await getLedgerRow(service, reservation.reservationId),
      usage: await getUsageRow(service, user.id),
      global: await getGlobalUsageRow(service),
      profile: await service
        .from("ai_profile_usage_daily")
        .select("*")
        .eq("profile_version_id", harness.fixture.profileVersionId),
    }).toEqual(before);
  });

  it("settles reported, not-applicable, and unavailable cache conservation branches", async () => {
    const cases = [
      {
        label: "reported",
        usage: observedUsage(),
        expected: {
          cache_usage_reporting: "reported",
          input_total_tokens: 100,
          input_cache_read_tokens: 60,
          input_cache_write_tokens: 10,
          input_standard_tokens: 30,
          input_cached_tokens: 60,
          input_uncached_tokens: 40,
          incomplete_fields: [],
        },
      },
      {
        label: "not-applicable",
        usage: observedUsage({
          input_total_tokens: 70,
          input_cache_read_tokens: 0,
          input_cache_write_tokens: 0,
          input_standard_tokens: 70,
          cache_usage_reporting: "not_applicable",
        }),
        expected: {
          cache_usage_reporting: "not_applicable",
          input_total_tokens: 70,
          input_cache_read_tokens: 0,
          input_cache_write_tokens: 0,
          input_standard_tokens: 70,
          input_cached_tokens: 0,
          input_uncached_tokens: 70,
          incomplete_fields: [],
        },
      },
      {
        label: "unavailable",
        usage: observedUsage({
          input_total_tokens: 70,
          input_cache_read_tokens: 20,
          input_cache_write_tokens: null,
          input_standard_tokens: 50,
          reasoning_tokens: null,
          cache_usage_reporting: "unavailable",
        }),
        expected: {
          cache_usage_reporting: "unavailable",
          input_total_tokens: 70,
          input_cache_read_tokens: 20,
          input_cache_write_tokens: null,
          input_standard_tokens: 50,
          input_cached_tokens: 20,
          input_uncached_tokens: 50,
          incomplete_fields: ["input_cache_write", "reasoning"],
        },
      },
    ];

    for (const value of cases) {
      const completedValue = await completed(`finalize-cache-${value.label}`, {
        p_usage: value.usage,
      });
      expect(
        await harness.finalize(completedValue.reservation.reservationId),
      ).toMatchObject({ ok: true, alreadyFinalized: false });
      expect(
        await getLedgerRow(service, completedValue.reservation.reservationId),
      ).toMatchObject({
        ...value.expected,
        usage_complete: true,
      });
    }
  });

  it("aggregates provider reports as all, partial, none, incomplete-local, or false-excluded", async () => {
    type CompletionOverrides = NonNullable<
      Parameters<typeof completePayload>[1]
    >;

    async function settleCase(
      label: string,
      attempts: CompletionOverrides[],
      expectedRequest: Record<string, unknown>,
      expectedDaily: Record<string, unknown>,
    ) {
      await harness.activateFreshRouteFixture();
      const user = await harness.makeUser(`finalize-provider-${label}`);
      const reservation = await harness.reserveV2(user);
      for (const [index, overrides] of attempts.entries()) {
        const attempt = await harness.startAttempt(
          reservation.reservationId,
          (index + 1) as 1 | 2,
        );
        expect(
          await harness.complete(
            completePayload(
              attempt.attemptId,
              attempts.length > 1 && index === 0
                ? {
                    ...overrides,
                    p_status: "failed_upstream",
                    p_retry_eligible: true,
                  }
                : overrides,
            ),
          ),
        ).toMatchObject({ ok: true, alreadyCompleted: false });
      }
      const lastStatus = attempts.at(-1)?.p_status ?? "succeeded";
      const derivedStatus =
        lastStatus === "timed_out" ? "failed_upstream" : lastStatus;
      const derivedQuota =
        derivedStatus === "succeeded"
          ? true
          : derivedStatus === "canceled"
            ? attempts.some((attempt) => attempt.p_transmitted !== false)
            : false;
      const billableFacts = attempts.map(
        (attempt) =>
          attempt.p_provider_billable === undefined
            ? true
            : attempt.p_provider_billable,
      );
      const derivedBillable = billableFacts.some((billable) => billable === true)
        ? true
        : billableFacts.every((billable) => billable === false)
          ? false
          : null;
      expect(
        await harness.finalize(reservation.reservationId, {
          status: derivedStatus,
          quotaCharged: derivedQuota,
          providerBillable: derivedBillable,
        }),
      ).toMatchObject({
        ok: true,
        alreadyFinalized: false,
      });
      expect(await getLedgerRow(service, reservation.reservationId)).toMatchObject(
        expectedRequest,
      );
      expect(await getProfileDaily()).toMatchObject(expectedDaily);
    }

    await settleCase(
      "matched",
      [
        {
          p_cost: costObservation({
            provider_reported_currency: "CNY",
            provider_reported_cost_nanos: "1234",
            reconciliation_status: "matched",
          }),
        },
      ],
      {
        known_estimated_cost_nanos: 1234,
        estimated_cost_nanos: 1234,
        provider_reported_currency: "CNY",
        provider_reported_cost_nanos: 1234,
        cost_reconciliation_status: "matched",
      },
      {
        known_estimated_cost_nanos: 1234,
        estimated_cost_nanos: 1234,
        provider_reported_cost_nanos: 1234,
        cost_incomplete_count: 0,
        provider_report_incomplete_count: 0,
      },
    );

    await settleCase(
      "mismatch",
      [
        {
          p_cost: costObservation({
            provider_reported_currency: "CNY",
            provider_reported_cost_nanos: "1235",
            reconciliation_status: "mismatch",
          }),
        },
      ],
      {
        estimated_cost_nanos: 1234,
        provider_reported_currency: "CNY",
        provider_reported_cost_nanos: 1235,
        cost_reconciliation_status: "mismatch",
      },
      {
        provider_reported_cost_nanos: 1235,
        cost_incomplete_count: 0,
        provider_report_incomplete_count: 0,
      },
    );

    await settleCase(
      "zero",
      [
        {
          p_cost: costObservation({
            estimated_cost_nanos: "0",
            provider_reported_currency: "CNY",
            provider_reported_cost_nanos: "0",
            reconciliation_status: "matched",
          }),
        },
      ],
      {
        known_estimated_cost_nanos: 0,
        estimated_cost_nanos: 0,
        provider_reported_currency: "CNY",
        provider_reported_cost_nanos: 0,
        cost_reconciliation_status: "matched",
      },
      {
        known_estimated_cost_nanos: 0,
        estimated_cost_nanos: 0,
        provider_reported_cost_nanos: 0,
        cost_incomplete_count: 0,
        provider_report_incomplete_count: 0,
      },
    );

    await settleCase(
      "partial",
      [
        {
          p_cost: costObservation({
            estimated_cost_nanos: "100",
            provider_reported_currency: "CNY",
            provider_reported_cost_nanos: "90",
            reconciliation_status: "mismatch",
          }),
        },
        {
          p_cost: costObservation({
            estimated_cost_nanos: "200",
          }),
        },
      ],
      {
        known_estimated_cost_nanos: 300,
        estimated_cost_nanos: 300,
        provider_reported_currency: null,
        provider_reported_cost_nanos: null,
        cost_reconciliation_status: "pending",
      },
      {
        known_estimated_cost_nanos: 300,
        estimated_cost_nanos: 300,
        provider_reported_cost_nanos: null,
        cost_incomplete_count: 0,
        provider_report_incomplete_count: 1,
      },
    );

    await settleCase(
      "none",
      [{}],
      {
        estimated_cost_nanos: 1234,
        provider_reported_currency: null,
        provider_reported_cost_nanos: null,
        cost_reconciliation_status: "not_available",
      },
      {
        provider_reported_cost_nanos: null,
        cost_incomplete_count: 0,
        provider_report_incomplete_count: 1,
      },
    );

    await settleCase(
      "local-incomplete-all-reported",
      [
        {
          p_cost: costObservation({
            estimated_currency: null,
            estimated_cost_nanos: null,
            provider_reported_currency: "CNY",
            provider_reported_cost_nanos: "7",
            reconciliation_status: "incomplete_usage",
          }),
        },
      ],
      {
        known_estimated_cost_nanos: null,
        estimated_cost_nanos: null,
        provider_reported_currency: "CNY",
        provider_reported_cost_nanos: 7,
        cost_reconciliation_status: "incomplete_usage",
        incomplete_fields: ["estimated_cost"],
      },
      {
        known_estimated_cost_nanos: 0,
        estimated_cost_nanos: null,
        provider_reported_cost_nanos: 7,
        cost_incomplete_count: 1,
        provider_report_incomplete_count: 0,
      },
    );

    await settleCase(
      "false-excluded",
      [
        {
          p_cost: costObservation({
            estimated_cost_nanos: "10",
            provider_reported_currency: "CNY",
            provider_reported_cost_nanos: "10",
            reconciliation_status: "matched",
          }),
        },
        {
          p_status: "canceled",
          p_transmitted: false,
          p_provider_billable: false,
          p_usage: null,
          p_cost: costObservation({
            estimated_currency: null,
            estimated_cost_nanos: null,
            provider_reported_currency: "CNY",
            provider_reported_cost_nanos: "0",
            reconciliation_status: "incomplete_usage",
          }),
          p_metadata: attemptMetadata({ finish_reason: null }),
        },
      ],
      {
        provider_billable: true,
        known_estimated_cost_nanos: 10,
        estimated_cost_nanos: 10,
        provider_reported_currency: "CNY",
        provider_reported_cost_nanos: 10,
        cost_reconciliation_status: "matched",
      },
      {
        provider_reported_cost_nanos: 10,
        cost_incomplete_count: 0,
        provider_report_incomplete_count: 0,
      },
    );
  });

  it("keeps daily local-cost completeness sticky across complete-null, known, and incomplete requests", async () => {
    await harness.activateFreshRouteFixture();

    const completeNull = await completed("daily-cost-complete-null", {
      p_status: "canceled",
      p_transmitted: false,
      p_provider_billable: false,
      p_usage: null,
      p_cost: costObservation({
        estimated_currency: null,
        estimated_cost_nanos: null,
        provider_reported_currency: "CNY",
        provider_reported_cost_nanos: "0",
        reconciliation_status: "incomplete_usage",
      }),
      p_metadata: attemptMetadata({ finish_reason: null }),
    });
    const completeNullResult = await harness.finalize(
      completeNull.reservation.reservationId,
      {
        status: "canceled",
        quotaCharged: false,
        providerBillable: false,
      },
    );
    expect(completeNullResult).toMatchObject({ ok: true, alreadyFinalized: false });
    expect(await getLedgerRow(service, completeNull.reservation.reservationId)).toMatchObject(
      {
        known_estimated_cost_nanos: null,
        estimated_cost_nanos: null,
        cost_reconciliation_status: "not_available",
      },
    );
    expect(await getProfileDaily()).toMatchObject({
      known_estimated_cost_nanos: 0,
      estimated_cost_nanos: 0,
      provider_reported_cost_nanos: null,
      cost_incomplete_count: 0,
      provider_report_incomplete_count: 0,
    });

    const beforeReplay = await getProfileDaily();
    expect(
      await harness.finalize(completeNull.reservation.reservationId, {
        status: "succeeded",
        providerBillable: true,
      }),
    ).toEqual({ ok: false, reason: "FINALIZE_CONFLICT" });
    expect(await getProfileDaily()).toEqual(beforeReplay);

    const known = await completed("daily-cost-known");
    await harness.finalize(known.reservation.reservationId);
    expect(await getProfileDaily()).toMatchObject({
      known_estimated_cost_nanos: 1234,
      estimated_cost_nanos: 1234,
      cost_incomplete_count: 0,
    });

    const secondCompleteNull = await completed("daily-cost-known-then-null", {
      p_status: "canceled",
      p_transmitted: false,
      p_provider_billable: false,
      p_usage: null,
      p_cost: costObservation({
        estimated_currency: null,
        estimated_cost_nanos: null,
        reconciliation_status: "incomplete_usage",
      }),
      p_metadata: attemptMetadata({ finish_reason: null }),
    });
    await harness.finalize(secondCompleteNull.reservation.reservationId, {
      status: "canceled",
      quotaCharged: false,
      providerBillable: false,
    });
    expect(await getProfileDaily()).toMatchObject({
      known_estimated_cost_nanos: 1234,
      estimated_cost_nanos: 1234,
      cost_incomplete_count: 0,
    });

    await harness.activateFreshRouteFixture();
    const incomplete = await completed("daily-cost-incomplete", {
      p_cost: costObservation({
        estimated_currency: null,
        estimated_cost_nanos: null,
        reconciliation_status: "incomplete_usage",
      }),
    });
    await harness.finalize(incomplete.reservation.reservationId);
    expect(await getProfileDaily()).toMatchObject({
      known_estimated_cost_nanos: 0,
      estimated_cost_nanos: null,
      cost_incomplete_count: 1,
    });

    const knownAfterIncomplete = await completed("daily-cost-incomplete-then-known");
    const knownAfterIncompleteResult = await harness.finalize(
      knownAfterIncomplete.reservation.reservationId,
    );
    expect(await getProfileDaily()).toMatchObject({
      known_estimated_cost_nanos: 1234,
      estimated_cost_nanos: null,
      cost_incomplete_count: 1,
    });
    const afterKnown = await getProfileDaily();
    expect(
      await harness.finalize(knownAfterIncomplete.reservation.reservationId),
    ).toEqual({ ...knownAfterIncompleteResult, alreadyFinalized: true });
    expect(await getProfileDaily()).toEqual(afterKnown);
  });

  it("keeps profile cache-write and reasoning nullable totals sticky in both request orders", async () => {
    const unavailableUsage = observedUsage({
      input_total_tokens: 60,
      input_cache_read_tokens: 20,
      input_cache_write_tokens: null,
      input_standard_tokens: 40,
      output_tokens: 10,
      reasoning_tokens: null,
      cache_usage_reporting: "unavailable",
    });

    async function settleUsage(label: string, usage: Record<string, unknown>) {
      const value = await completed(label, { p_usage: usage });
      await harness.finalize(value.reservation.reservationId);
      return getLedgerRow(service, value.reservation.reservationId);
    }

    await harness.activateFreshRouteFixture();
    await settleUsage("daily-sticky-known-first", observedUsage());
    expect(await getProfileDaily()).toMatchObject({
      input_cache_write_tokens: 10,
      reasoning_tokens: 5,
    });
    expect(
      await settleUsage("daily-sticky-unknown-second", unavailableUsage),
    ).toMatchObject({
      input_cache_write_tokens: null,
      reasoning_tokens: null,
    });
    expect(await getProfileDaily()).toMatchObject({
      input_cache_write_tokens: null,
      reasoning_tokens: null,
    });

    await harness.activateFreshRouteFixture();
    await settleUsage("daily-sticky-unknown-first", unavailableUsage);
    expect(await getProfileDaily()).toMatchObject({
      input_cache_write_tokens: null,
      reasoning_tokens: null,
    });
    await settleUsage("daily-sticky-known-second", observedUsage());
    expect(await getProfileDaily()).toMatchObject({
      input_cache_write_tokens: null,
      reasoning_tokens: null,
    });
  });

  it("enforces request and profile cost truth tables without SQL NULL bypass", async () => {
    await harness.activateFreshRouteFixture();
    const matched = await completed("direct-cost-check-probe", {
      p_cost: costObservation({
        provider_reported_currency: "CNY",
        provider_reported_cost_nanos: "1234",
        reconciliation_status: "matched",
      }),
    });
    await harness.finalize(matched.reservation.reservationId);

    runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      create temporary table request_check_probe
        (like public.ai_request_ledger including all);
      insert into request_check_probe
      select * from public.ai_request_ledger
      where reservation_id = '${matched.reservation.reservationId}'::uuid;

      create temporary table profile_check_probe
        (like public.ai_profile_usage_daily including all);
      insert into profile_check_probe
      select * from public.ai_profile_usage_daily
      where profile_version_id = '${harness.fixture.profileVersionId}'::uuid
        and billing_currency = 'CNY';

      do $assertions$
      begin
        update request_check_probe
        set cache_usage_reporting = 'unavailable',
            input_total_tokens = 100,
            input_cache_read_tokens = 60,
            input_cache_write_tokens = null,
            input_standard_tokens = 30,
            incomplete_fields = array['input_cache_write']::text[];

        begin
          update request_check_probe set input_total_tokens = 89;
          raise exception 'request unavailable lower-bound CHECK accepted underflow';
        exception when check_violation then
          null;
        end;

        update request_check_probe
        set cache_usage_reporting = 'reported',
            input_total_tokens = 100,
            input_cache_read_tokens = 60,
            input_cache_write_tokens = 10,
            input_standard_tokens = 30,
            incomplete_fields = array['estimated_cost']::text[],
            known_estimated_cost_nanos = 1234,
            estimated_cost_nanos = null,
            provider_reported_currency = 'CNY',
            provider_reported_cost_nanos = 1234,
            cost_reconciliation_status = 'incomplete_usage';

        begin
          update request_check_probe set incomplete_fields = array[]::text[];
          raise exception 'request incomplete_usage CHECK accepted missing marker';
        exception when check_violation then
          null;
        end;

        begin
          update request_check_probe
          set incomplete_fields = array[]::text[],
              estimated_cost_nanos = 1234,
              cost_reconciliation_status = 'pending';
          raise exception 'request pending CHECK accepted a partial amount';
        exception when check_violation then
          null;
        end;

        update request_check_probe
        set incomplete_fields = array[]::text[],
            estimated_cost_nanos = 1234,
            cost_reconciliation_status = 'matched';

        begin
          update request_check_probe set provider_reported_currency = null;
          raise exception 'request provider pair CHECK allowed SQL NULL bypass';
        exception when check_violation then
          null;
        end;

        update request_check_probe
        set provider_billable = false,
            known_estimated_cost_nanos = null,
            estimated_cost_nanos = null,
            provider_reported_currency = null,
            provider_reported_cost_nanos = null,
            cost_reconciliation_status = 'not_available',
            incomplete_fields = array[]::text[];

        begin
          update request_check_probe set provider_billable = true;
          raise exception 'request complete-null CHECK accepted billable true';
        exception when check_violation then
          null;
        end;

        update profile_check_probe
        set cost_incomplete_count = 0,
            known_estimated_cost_nanos = 7,
            estimated_cost_nanos = 7;

        begin
          update profile_check_probe set estimated_cost_nanos = null;
          raise exception 'profile count-zero CHECK accepted estimated NULL';
        exception when check_violation then
          null;
        end;

        update profile_check_probe
        set cost_incomplete_count = 1,
            estimated_cost_nanos = null;

        begin
          update profile_check_probe set estimated_cost_nanos = 7;
          raise exception 'profile incomplete CHECK accepted estimated value';
        exception when check_violation then
          null;
        end;
      end
      $assertions$;
    `);
  });

  it("serializes concurrent duplicate completion in independent database sessions", async () => {
    await harness.activateFreshRouteFixture();
    const value = await started("concurrent-complete-replay");
    const race = await runObservedBlockedRace(
      completeAttemptSql(value.attempt.attemptId, {
        markerAfter: "DB010_COMPLETE_HOLDER_READY",
        commit: false,
      }),
      "DB010_COMPLETE_HOLDER_READY",
      completeAttemptSql(value.attempt.attemptId, {
        markerBefore: "DB010_COMPLETE_CONTENDER_READY",
      }),
      "DB010_COMPLETE_CONTENDER_READY",
    );

    expect(race.holder.status, race.holder.stderr).toBe(0);
    expect(race.holder.stdout).toContain('"alreadyCompleted": false');
    expect(race.contender.status, race.contender.stderr).toBe(0);
    expect(race.contender.stdout).toContain('"alreadyCompleted": true');
    const attempts = await service
      .from("ai_provider_attempt_ledger")
      .select("*")
      .eq("reservation_id", value.reservation.reservationId);
    expect(attempts.error).toBeNull();
    expect(attempts.data).toHaveLength(1);
    expect(attempts.data![0]).toMatchObject({
      status: "succeeded",
      usage_observation_kind: "observed",
      estimated_cost_nanos: 1234,
    });
    expect(await getLedgerRow(service, value.reservation.reservationId)).toMatchObject({
      state: "reserved",
      attempt_count: 1,
      usage_schema_version: null,
    });
  });

  it("serializes concurrent duplicate finalization into one settlement and one replay", async () => {
    await harness.activateFreshRouteFixture();
    const value = await completed("concurrent-finalize-replay");
    const race = await runObservedBlockedRace(
      finalizeAttemptSql(value.reservation.reservationId, {
        markerAfter: "DB010_FINALIZE_HOLDER_READY",
        commit: false,
      }),
      "DB010_FINALIZE_HOLDER_READY",
      finalizeAttemptSql(value.reservation.reservationId, {
        markerBefore: "DB010_FINALIZE_CONTENDER_READY",
      }),
      "DB010_FINALIZE_CONTENDER_READY",
    );

    expect(race.holder.status, race.holder.stderr).toBe(0);
    expect(race.holder.stdout).toContain('"alreadyFinalized": false');
    expect(race.contender.status, race.contender.stderr).toBe(0);
    expect(race.contender.stdout).toContain('"alreadyFinalized": true');
    expect(await getLedgerRow(service, value.reservation.reservationId)).toMatchObject({
      state: "finalized",
      input_cached_tokens: 60,
      input_uncached_tokens: 40,
      output_tokens: 20,
    });
    expect(await getUsageRow(service, value.user.id)).toMatchObject({
      request_count: 1,
      input_cached_tokens: 60,
      input_uncached_tokens: 40,
      output_tokens: 20,
    });
    expect(await getProfileDaily()).toMatchObject({
      request_count: 1,
      input_total_tokens: 100,
      known_estimated_cost_nanos: 1234,
    });
  });

  it("finalizes a transmitted V2 cancellation whose child failed in transport", async () => {
    await harness.activateFreshRouteFixture();
    const value = await completed("v2-transport-cancellation", {
      p_status: "canceled",
      p_transmitted: true,
      p_retry_eligible: false,
      p_provider_billable: null,
      p_usage: null,
      p_cost: costObservation({
        estimated_currency: null,
        estimated_cost_nanos: null,
        reconciliation_status: "incomplete_usage",
      }),
      p_metadata: attemptMetadata({
        finish_reason: null,
        failure_stage: "transport",
      }),
    });
    const before = await settlementSnapshot(
      value.user.id,
      value.reservation.reservationId,
    );

    const cancellation = await service.rpc(
      "record_ai_polish_request_cancellation",
      {
        p_reservation_id: value.reservation.reservationId,
        p_observation: "observed",
      },
    );
    expect(cancellation.error).toBeNull();
    expect(cancellation.data).toMatchObject({ ok: true, state: "observed" });
    expect(
      await harness.finalize(value.reservation.reservationId, {
        status: "canceled",
        quotaCharged: true,
        providerBillable: null,
      }),
    ).toMatchObject({
      ok: true,
      alreadyFinalized: false,
      status: "canceled",
      quotaCharged: true,
    });

    const attempts = await service
      .from("ai_provider_attempt_ledger")
      .select("*")
      .eq("reservation_id", value.reservation.reservationId)
      .order("attempt_no");
    expect(attempts.error).toBeNull();
    expect(attempts.data).toHaveLength(1);
    expect(attempts.data![0]).toMatchObject({
      status: "canceled",
      transmitted: true,
      retry_eligible: false,
      provider_billable: null,
      usage_observation_kind: "unavailable",
      cost_reconciliation_status: "incomplete_usage",
      failure_stage: "transport",
    });

    const terminal = await settlementSnapshot(
      value.user.id,
      value.reservation.reservationId,
    );
    expect(terminal.request).toMatchObject({
      state: "finalized",
      status: "canceled",
      quota_charged: true,
      provider_billable: null,
      cancellation_state: "observed",
      attempt_count: 1,
      failure_stage: "transport",
      usage_schema_version: "request_usage_aggregate_v2",
      usage_complete: false,
      estimated_cost_nanos: null,
      cost_reconciliation_status: "incomplete_usage",
    });
    expect(terminal.request!.incomplete_fields).toEqual(
      expect.arrayContaining([
        "attempt_usage",
        "input_cache_write",
        "reasoning",
        "provider_billable",
        "estimated_cost",
      ]),
    );
    expect(terminal.user).toEqual(before.user);
    expect(terminal.global).toEqual(before.global);
    expect(terminal.profile).toHaveLength(1);
    expect(terminal.profile[0]).toMatchObject({
      request_count: 1,
      input_total_tokens: 0,
      output_tokens: 0,
      cost_incomplete_count: 1,
    });

    expect(
      await harness.finalize(value.reservation.reservationId, {
        status: "canceled",
        quotaCharged: true,
        providerBillable: null,
      }),
    ).toMatchObject({ ok: true, alreadyFinalized: true, status: "canceled" });
    const cancellationReplay = await service.rpc(
      "record_ai_polish_request_cancellation",
      {
        p_reservation_id: value.reservation.reservationId,
        p_observation: "observed",
      },
    );
    expect(cancellationReplay.error).toBeNull();
    expect(cancellationReplay.data).toEqual({
      ok: false,
      reason: "ALREADY_FINALIZED",
    });
    expect(
      await settlementSnapshot(value.user.id, value.reservation.reservationId),
    ).toEqual(terminal);
  });

  it("linearizes cancellation-first settlement and keeps charged counters exact on replay", async () => {
    await harness.activateFreshRouteFixture();
    const value = await completed("race-cancellation-before-finalize", {
      p_status: "failed_upstream",
      p_transmitted: true,
      p_retry_eligible: false,
      p_provider_billable: null,
      p_usage: null,
      p_cost: costObservation({
        estimated_currency: null,
        estimated_cost_nanos: null,
        reconciliation_status: "incomplete_usage",
      }),
      p_metadata: attemptMetadata({
        finish_reason: null,
        failure_stage: "provider_http",
      }),
    });
    const beforeUser = await getUsageRow(service, value.user.id);
    const beforeGlobal = await getGlobalUsageRow(service);

    const race = await runObservedBlockedRace(
      observeCancellationSql(value.reservation.reservationId, {
        markerAfter: "DB010_CANCELLATION_FIRST_READY",
        commit: false,
      }),
      "DB010_CANCELLATION_FIRST_READY",
      finalizeCanceledAttemptSql(value.reservation.reservationId, {
        markerBefore: "DB010_CANCELED_FINALIZER_READY",
      }),
      "DB010_CANCELED_FINALIZER_READY",
    );

    expect(race.holder.status, race.holder.stderr).toBe(0);
    expect(race.holder.stdout).toContain('"state": "observed"');
    expect(race.contender.status, race.contender.stderr).toBe(0);
    expect(race.contender.stdout).toContain('"alreadyFinalized": false');
    expect(race.contender.stdout).toContain('"status": "canceled"');

    const terminal = await settlementSnapshot(
      value.user.id,
      value.reservation.reservationId,
    );
    expect(terminal.request).toMatchObject({
      state: "finalized",
      status: "canceled",
      quota_charged: true,
      cancellation_state: "observed",
      attempt_count: 1,
    });
    expect(terminal.user).toMatchObject({
      request_count: beforeUser!.request_count,
      input_cached_tokens: beforeUser!.input_cached_tokens,
      input_uncached_tokens: beforeUser!.input_uncached_tokens,
      output_tokens: beforeUser!.output_tokens,
    });
    expect(terminal.global).toMatchObject({
      provider_started_count: beforeGlobal!.provider_started_count,
      input_cached_tokens: beforeGlobal!.input_cached_tokens,
      input_uncached_tokens: beforeGlobal!.input_uncached_tokens,
      output_tokens: beforeGlobal!.output_tokens,
    });
    expect(await getProfileDaily()).toMatchObject({
      request_count: 1,
      input_total_tokens: 0,
      output_tokens: 0,
    });

    expect(
      await harness.finalize(value.reservation.reservationId, {
        status: "canceled",
        quotaCharged: true,
        providerBillable: null,
      }),
    ).toMatchObject({ ok: true, alreadyFinalized: true, status: "canceled" });
    const cancellationReplay = await service.rpc(
      "record_ai_polish_request_cancellation",
      {
        p_reservation_id: value.reservation.reservationId,
        p_observation: "observed",
      },
    );
    expect(cancellationReplay.error).toBeNull();
    expect(cancellationReplay.data).toEqual({
      ok: false,
      reason: "ALREADY_FINALIZED",
    });
    expect(
      await settlementSnapshot(value.user.id, value.reservation.reservationId),
    ).toEqual(terminal);
  });

  it("linearizes finalize-first cancellation and preserves exact terminal replay", async () => {
    await harness.activateFreshRouteFixture();
    const value = await completed("race-finalize-before-cancellation");
    const beforeGlobal = await getGlobalUsageRow(service);

    const race = await runObservedBlockedRace(
      finalizeAttemptSql(value.reservation.reservationId, {
        markerAfter: "DB010_FINALIZE_BEFORE_CANCELLATION_READY",
        commit: false,
      }),
      "DB010_FINALIZE_BEFORE_CANCELLATION_READY",
      observeCancellationSql(value.reservation.reservationId, {
        markerBefore: "DB010_LATE_CANCELLATION_READY",
      }),
      "DB010_LATE_CANCELLATION_READY",
    );

    expect(race.holder.status, race.holder.stderr).toBe(0);
    expect(race.holder.stdout).toContain('"alreadyFinalized": false');
    expect(race.holder.stdout).toContain('"status": "succeeded"');
    expect(race.contender.status, race.contender.stderr).toBe(0);
    expect(race.contender.stdout).toContain('"reason": "ALREADY_FINALIZED"');

    const terminal = await settlementSnapshot(
      value.user.id,
      value.reservation.reservationId,
    );
    expect(terminal.request).toMatchObject({
      state: "finalized",
      status: "succeeded",
      quota_charged: true,
      cancellation_state: null,
      attempt_count: 1,
      input_total_tokens: 100,
      output_tokens: 20,
    });
    expect(terminal.user).toMatchObject({
      request_count: 1,
      input_cached_tokens: 60,
      input_uncached_tokens: 40,
      output_tokens: 20,
    });
    expect(terminal.global).toMatchObject({
      provider_started_count: beforeGlobal!.provider_started_count,
      input_cached_tokens: beforeGlobal!.input_cached_tokens + 60,
      input_uncached_tokens: beforeGlobal!.input_uncached_tokens + 40,
      output_tokens: beforeGlobal!.output_tokens + 20,
    });
    expect(await getProfileDaily()).toMatchObject({
      request_count: 1,
      input_total_tokens: 100,
      input_cache_read_tokens: 60,
      input_standard_tokens: 30,
      output_tokens: 20,
      known_estimated_cost_nanos: 1234,
    });

    expect(
      await harness.finalize(value.reservation.reservationId),
    ).toMatchObject({ ok: true, alreadyFinalized: true, status: "succeeded" });
    const cancellationReplay = await service.rpc(
      "record_ai_polish_request_cancellation",
      {
        p_reservation_id: value.reservation.reservationId,
        p_observation: "observed",
      },
    );
    expect(cancellationReplay.error).toBeNull();
    expect(cancellationReplay.data).toEqual({
      ok: false,
      reason: "ALREADY_FINALIZED",
    });
    expect(
      await settlementSnapshot(value.user.id, value.reservation.reservationId),
    ).toEqual(terminal);
  });

  it("linearizes complete versus finalize in both request-lock orders without losing a fact", async () => {
    await harness.activateFreshRouteFixture();
    const completeFirst = await started("race-complete-first");
    const completionWins = await runObservedBlockedRace(
      completeAttemptSql(completeFirst.attempt.attemptId, {
        markerAfter: "DB010_COMPLETE_FIRST_READY",
        commit: false,
      }),
      "DB010_COMPLETE_FIRST_READY",
      finalizeAttemptSql(completeFirst.reservation.reservationId, {
        markerBefore: "DB010_COMPLETE_FIRST_FINALIZER_READY",
      }),
      "DB010_COMPLETE_FIRST_FINALIZER_READY",
    );
    expect(completionWins.holder.status, completionWins.holder.stderr).toBe(0);
    expect(completionWins.holder.stdout).toContain('"alreadyCompleted": false');
    expect(
      completionWins.contender.status,
      completionWins.contender.stderr,
    ).toBe(0);
    expect(completionWins.contender.stdout).toContain('"alreadyFinalized": false');
    expect(
      await getLedgerRow(service, completeFirst.reservation.reservationId),
    ).toMatchObject({
      state: "finalized",
      usage_schema_version: "request_usage_aggregate_v2",
      input_total_tokens: 100,
    });
    expect(await getProfileDaily()).toMatchObject({ request_count: 1 });

    await harness.activateFreshRouteFixture();
    const finalizeFirst = await started("race-finalize-first");
    const finalizerWins = await runObservedBlockedRace(
      finalizeAttemptSql(finalizeFirst.reservation.reservationId, {
        markerAfter: "DB010_FINALIZE_FIRST_READY",
        commit: false,
      }),
      "DB010_FINALIZE_FIRST_READY",
      completeAttemptSql(finalizeFirst.attempt.attemptId, {
        markerBefore: "DB010_FINALIZE_FIRST_COMPLETER_READY",
      }),
      "DB010_FINALIZE_FIRST_COMPLETER_READY",
    );
    expect(finalizerWins.holder.status, finalizerWins.holder.stderr).toBe(0);
    expect(finalizerWins.holder.stdout).toContain('"ok": false');
    expect(finalizerWins.contender.status, finalizerWins.contender.stderr).toBe(0);
    expect(finalizerWins.contender.stdout).toContain('"alreadyCompleted": false');
    expect(await getLedgerRow(service, finalizeFirst.reservation.reservationId)).toMatchObject(
      {
        state: "reserved",
        attempt_count: 1,
      },
    );

    expect(
      await harness.finalize(finalizeFirst.reservation.reservationId),
    ).toMatchObject({ ok: true, alreadyFinalized: false });
    expect(await getLedgerRow(service, finalizeFirst.reservation.reservationId)).toMatchObject(
      {
        state: "finalized",
        input_total_tokens: 100,
      },
    );
    expect(await getProfileDaily()).toMatchObject({ request_count: 1 });
  });

  it("serializes start versus finalize without admitting a phantom attempt", async () => {
    await harness.activateFreshRouteFixture();
    const finalizeFirst = await completed("race-finalize-before-late-start");
    const finalizerWins = await runObservedBlockedRace(
      parentLockSql(
        finalizeFirst.reservation.reservationId,
        "DB010_FINALIZE_BEFORE_START_READY",
      ),
      "DB010_FINALIZE_BEFORE_START_READY",
      startAttemptSql(finalizeFirst.reservation.reservationId, 2, {
        markerBefore: "DB010_LATE_START_READY",
      }),
      "DB010_LATE_START_READY",
      finalizeAttemptActionSql(finalizeFirst.reservation.reservationId),
    );
    expect(finalizerWins.holder.status, finalizerWins.holder.stderr).toBe(0);
    expect(finalizerWins.holder.stdout).toContain('"alreadyFinalized": false');
    expect(finalizerWins.contender.status, finalizerWins.contender.stderr).toBe(0);
    expect(finalizerWins.contender.stdout).toContain('"reason": "ALREADY_FINALIZED"');
    const finalizedAttempts = await service
      .from("ai_provider_attempt_ledger")
      .select("attempt_no,status")
      .eq("reservation_id", finalizeFirst.reservation.reservationId)
      .order("attempt_no");
    expect(finalizedAttempts.error).toBeNull();
    expect(finalizedAttempts.data).toEqual([
      { attempt_no: 1, status: "succeeded" },
    ]);

    await harness.activateFreshRouteFixture();
    const startFirst = await completed("race-start-before-finalize", {
      p_status: "failed_upstream",
      p_retry_eligible: true,
    });
    const starterWins = await runObservedBlockedRace(
      parentLockSql(
        startFirst.reservation.reservationId,
        "DB010_START_BEFORE_FINALIZE_READY",
      ),
      "DB010_START_BEFORE_FINALIZE_READY",
      finalizeAttemptSql(startFirst.reservation.reservationId, {
        markerBefore: "DB010_FINALIZE_AFTER_START_READY",
      }),
      "DB010_FINALIZE_AFTER_START_READY",
      startAttemptActionSql(startFirst.reservation.reservationId, 2),
    );
    expect(starterWins.holder.status, starterWins.holder.stderr).toBe(0);
    expect(starterWins.holder.stdout).toContain('"alreadyStarted": false');
    expect(starterWins.contender.status, starterWins.contender.stderr).toBe(0);
    expect(starterWins.contender.stdout).toContain(
      '"reason": "ATTEMPT_IN_PROGRESS"',
    );
    expect(await getLedgerRow(service, startFirst.reservation.reservationId)).toMatchObject(
      {
        state: "reserved",
        attempt_count: 2,
      },
    );
    const admittedAttempts = await service
      .from("ai_provider_attempt_ledger")
      .select("attempt_no,status")
      .eq("reservation_id", startFirst.reservation.reservationId)
      .order("attempt_no");
    expect(admittedAttempts.error).toBeNull();
    expect(admittedAttempts.data).toEqual([
      { attempt_no: 1, status: "failed_upstream" },
      { attempt_no: 2, status: "started" },
    ]);
  });

  it("fails closed on stale high-isolation child snapshots and retries in RC", async () => {
    for (const isolation of ["repeatable read", "serializable"] as const) {
      await harness.activateFreshRouteFixture();
      const value = await started(`stale-snapshot-${isolation.replaceAll(" ", "-")}`);
      const beforeSettlement = await settlementSnapshot(
        value.user.id,
        value.reservation.reservationId,
      );
      const marker = `DB010_${isolation.replaceAll(" ", "_").toUpperCase()}_SNAPSHOT_READY`;
      const staleFinalizer = startOwnerSqlWithBarrier(
        staleSnapshotSql(value.attempt.attemptId, isolation, marker),
        marker,
        finalizeAttemptActionSql(value.reservation.reservationId),
      );
      let released = false;
      try {
        await staleFinalizer.ready;
        const completion = runOwnerSql(completeAttemptSql(value.attempt.attemptId));
        expect(completion.status, completion.stderr).toBe(0);
        expect(completion.stdout).toContain('"alreadyCompleted": false');

        staleFinalizer.release();
        released = true;
        const staleResult = await staleFinalizer.result;
        const safeStaleOutcome =
          (staleResult.status === 0 &&
            staleResult.stdout.includes('"reason": "ATTEMPT_IN_PROGRESS"')) ||
          (staleResult.status !== 0 &&
            (staleResult.stderr.includes("40001") ||
              staleResult.stderr.includes("could not serialize access")));
        expect(safeStaleOutcome, staleResult.stderr || staleResult.stdout).toBe(true);
      } finally {
        if (!released) {
          staleFinalizer.release();
        }
      }

      expect(
        await settlementSnapshot(value.user.id, value.reservation.reservationId),
      ).toEqual(beforeSettlement);
      expect(await harness.finalize(value.reservation.reservationId)).toMatchObject({
        ok: true,
        alreadyFinalized: false,
      });
    }
  });

  it("rolls back the whole settlement when request cost aggregation exceeds bigint", async () => {
    await harness.activateFreshRouteFixture();
    const user = await harness.makeUser("overflow-request-cost");
    const reservation = await harness.reserveV2(user);
    for (const attemptNo of [1, 2] as const) {
      const attempt = await harness.startAttempt(
        reservation.reservationId,
        attemptNo,
      );
      expect(
        await harness.complete(
          completePayload(attempt.attemptId, {
            ...(attemptNo === 1
              ? { p_status: "failed_upstream", p_retry_eligible: true }
              : {}),
            p_cost: costObservation({
              estimated_cost_nanos: "9223372036854775807",
            }),
          }),
        ),
      ).toMatchObject({ ok: true, alreadyCompleted: false });
    }

    const before = await settlementSnapshot(user.id, reservation.reservationId);
    expect(await harness.finalize(reservation.reservationId)).toEqual({
      ok: false,
      reason: "SERVICE_UNAVAILABLE",
    });
    expect(await settlementSnapshot(user.id, reservation.reservationId)).toEqual(
      before,
    );
  });

  it("rolls back request, inserted profile row, and every daily write on user overflow", async () => {
    await harness.activateFreshRouteFixture();
    const value = await completed("overflow-user-daily");
    runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      update public.ai_usage_daily
      set input_cached_tokens = 9223372036854775807
      where user_id = '${value.user.id}'::uuid
        and day = current_date;
    `);

    const before = await settlementSnapshot(
      value.user.id,
      value.reservation.reservationId,
    );
    expect(before.profile).toEqual([]);
    expect(await harness.finalize(value.reservation.reservationId)).toEqual({
      ok: false,
      reason: "SERVICE_UNAVAILABLE",
    });
    expect(
      await settlementSnapshot(value.user.id, value.reservation.reservationId),
    ).toEqual(before);
  });

  it("rolls back request, user, and inserted profile row on global overflow", async () => {
    await harness.activateFreshRouteFixture();
    const value = await completed("overflow-global-daily");
    const originalGlobal = await getGlobalUsageRow(service);
    expect(originalGlobal).not.toBeNull();
    runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      update public.ai_global_usage_daily
      set input_cached_tokens = 9223372036854775807
      where day = current_date;
    `);

    try {
      const before = await settlementSnapshot(
        value.user.id,
        value.reservation.reservationId,
      );
      expect(before.profile).toEqual([]);
      expect(await harness.finalize(value.reservation.reservationId)).toEqual({
        ok: false,
        reason: "SERVICE_UNAVAILABLE",
      });
      expect(
        await settlementSnapshot(value.user.id, value.reservation.reservationId),
      ).toEqual(before);
    } finally {
      runOwnerSql(String.raw`
        \set ON_ERROR_STOP on
        update public.ai_global_usage_daily
        set input_cached_tokens = ${originalGlobal!.input_cached_tokens}
        where day = current_date;
      `);
    }
  });

  it("rolls back every mutation for profile bigint, integer, and completeness-counter overflow", async () => {
    type CompletionOverrides = NonNullable<
      Parameters<typeof completePayload>[1]
    >;
    type FinalizeOptions = Parameters<SettlementHarness["finalize"]>[1];
    const maxInteger = "2147483647";
    const maxBigint = "9223372036854775807";
    const scenarios: Array<{
      label: string;
      seed: {
        requestCount?: string;
        usageIncompleteCount?: string;
        costIncompleteCount?: string;
        providerIncompleteCount?: string;
        inputTotal?: string;
        knownEstimated?: string;
        estimated?: string;
        providerReported?: string;
      };
      completion?: CompletionOverrides;
      finalize?: FinalizeOptions;
    }> = [
      {
        label: "request-count",
        seed: { requestCount: maxInteger },
      },
      {
        label: "usage-incomplete-count",
        seed: { usageIncompleteCount: maxInteger },
        completion: {
          p_status: "canceled",
          p_transmitted: false,
          p_provider_billable: false,
          p_usage: null,
          p_cost: costObservation({
            estimated_currency: null,
            estimated_cost_nanos: null,
            reconciliation_status: "incomplete_usage",
          }),
          p_metadata: attemptMetadata({ finish_reason: null }),
        },
        finalize: {
          status: "canceled",
          quotaCharged: false,
          providerBillable: false,
        },
      },
      {
        label: "cost-incomplete-count",
        seed: {
          costIncompleteCount: maxInteger,
          estimated: "null",
        },
        completion: {
          p_cost: costObservation({
            estimated_currency: null,
            estimated_cost_nanos: null,
            reconciliation_status: "incomplete_usage",
          }),
        },
      },
      {
        label: "provider-incomplete-count",
        seed: { providerIncompleteCount: maxInteger },
      },
      {
        label: "input-total",
        seed: { inputTotal: maxBigint },
      },
      {
        label: "known-estimated",
        seed: { knownEstimated: maxBigint, estimated: maxBigint },
      },
      {
        label: "provider-reported",
        seed: { providerReported: maxBigint },
        completion: {
          p_cost: costObservation({
            estimated_cost_nanos: "1",
            provider_reported_currency: "CNY",
            provider_reported_cost_nanos: "1",
            reconciliation_status: "matched",
          }),
        },
      },
    ];

    for (const scenario of scenarios) {
      await harness.activateFreshRouteFixture();
      const value = await completed(
        `overflow-profile-${scenario.label}`,
        scenario.completion,
      );
      const seed = {
        requestCount: "0",
        usageIncompleteCount: "0",
        costIncompleteCount: "0",
        providerIncompleteCount: "0",
        inputTotal: "0",
        knownEstimated: "0",
        estimated: "0",
        providerReported: "null",
        ...scenario.seed,
      };
      runOwnerSql(String.raw`
        \set ON_ERROR_STOP on
        insert into public.ai_profile_usage_daily (
          day,
          profile_version_id,
          billing_currency,
          request_count,
          usage_incomplete_count,
          cost_incomplete_count,
          provider_report_incomplete_count,
          input_total_tokens,
          input_cache_write_tokens,
          reasoning_tokens,
          known_estimated_cost_nanos,
          estimated_cost_nanos,
          provider_reported_cost_nanos
        ) values (
          current_date,
          '${harness.fixture.profileVersionId}'::uuid,
          'CNY',
          ${seed.requestCount},
          ${seed.usageIncompleteCount},
          ${seed.costIncompleteCount},
          ${seed.providerIncompleteCount},
          ${seed.inputTotal},
          0,
          0,
          ${seed.knownEstimated},
          ${seed.estimated},
          ${seed.providerReported}
        );
      `);

      try {
        const before = await settlementSnapshot(
          value.user.id,
          value.reservation.reservationId,
        );
        expect(before.profile).toHaveLength(1);
        expect(
          await harness.finalize(
            value.reservation.reservationId,
            scenario.finalize,
          ),
        ).toEqual({ ok: false, reason: "SERVICE_UNAVAILABLE" });
        expect(
          await settlementSnapshot(
            value.user.id,
            value.reservation.reservationId,
          ),
        ).toEqual(before);
      } finally {
        const cleanup = await service
          .from("ai_profile_usage_daily")
          .delete()
          .eq("profile_version_id", harness.fixture.profileVersionId)
          .eq("billing_currency", "CNY");
        expect(cleanup.error).toBeNull();
      }
    }
  });
});
