"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { useSearchParams } from "next/navigation";
import { LogIn, LogOut, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ThemeToggle } from "@/components/layout/toolbar/theme-toggle";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  adminContextSchema,
  adminErrorSchema,
  adminPageSchema,
  type AdminContext,
  type AdminPage,
  type AdminRecordSection,
  type AdminSection,
} from "@/lib/admin/contract";
import { adminMessages, type AdminMessages } from "./messages";
import { adminNavigationPath, adminOAuthRedirectUrl } from "./navigation";

type Props = { locale: "zh" | "en"; section?: AdminSection; recordId?: string };
type Query = { search: string; after: string; limit: number };
type LoadState = {
  context: AdminContext | null;
  page: AdminPage | null;
  error: string | null;
  loading: boolean;
};

function errorText(code: string, t: AdminMessages) {
  if (code === "FORBIDDEN" || code === "UNAUTHORIZED") return t.noAccess;
  if (code === "ENVIRONMENT_MISMATCH" || code === "NOT_READY")
    return t.noConfiguration;
  if (code === "UNAVAILABLE") return t.unavailable;
  if (code === "NOT_FOUND") return t.notFound;
  if (code === "INVALID_REQUEST") return t.invalid;
  if (code === "SCHEMA") return t.schemaError;
  return t.loadFailed;
}
function date(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
export function localizedAdminValue(
  value: unknown,
  locale: string,
  t: AdminMessages,
) {
  if (typeof value === "boolean") return value ? t.yes : t.no;
  if (
    typeof value === "string" &&
    value.includes("T") &&
    !Number.isNaN(Date.parse(value))
  )
    return date(value, locale);
  return value == null ? "—" : String(value);
}
export function buildAdminQuery(query: Query) {
  const params = new URLSearchParams();
  if (query.search) params.set("search", query.search);
  if (query.after) params.set("after", query.after);
  if (query.limit !== 25) params.set("limit", String(query.limit));
  const result = params.toString();
  return result ? `?${result}` : "";
}

export default function AdminApp({
  locale,
  section = "overview",
  recordId,
}: Props) {
  const t = adminMessages[locale];
  const client = useMemo(() => getSupabaseBrowserClient(), []);
  const [session, setSession] = useState<Session | null>(null);
  const [credentials, setCredentials] = useState({ email: "", password: "" });
  const [busy, setBusy] = useState(false);
  const initialQuery = useSearchParams();
  const [query, setQuery] = useState<Query>(() => {
    const limit = Number(initialQuery?.get("limit"));
    return {
      search: initialQuery?.get("search") ?? "", after: initialQuery?.get("after") ?? "",
      limit: Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : 25,
    };
  });
  const [state, setState] = useState<LoadState>({
    context: null,
    page: null,
    error: null,
    loading: false,
  });
  const requestGeneration = useRef(0);

  useEffect(() => {
    if (!client) return;
    let alive = true;
    let authEventObserved = false;
    void client.auth
      .getSession()
      .then(({ data, error }) => {
        if (!alive || authEventObserved) return;
        if (error) {
          setState({
            context: null,
            page: null,
            error: t.unavailable,
            loading: false,
          });
          setSession(null);
          return;
        }
        setState({
          context: null,
          page: null,
          error: null,
          loading: Boolean(data.session),
        });
        setSession(data.session);
      })
      .catch(() => {
        if (!alive || authEventObserved) return;
        setState({
          context: null,
          page: null,
          error: t.unavailable,
          loading: false,
        });
        setSession(null);
      });
    const { data: listener } = client.auth.onAuthStateChange((_event, next) => {
      if (!alive) return;
      authEventObserved = true;
      requestGeneration.current += 1;
      setState({ context: null, page: null, error: null, loading: Boolean(next) });
      setCredentials({ email: "", password: "" });
      setSession(next);
    });
    return () => {
      alive = false;
      requestGeneration.current += 1;
      listener.subscription.unsubscribe();
    };
  }, [client, t.unavailable]);
  const load = useCallback(async () => {
    if (!session?.access_token) return null;
    try {
      const params = new URLSearchParams({ section });
      if (recordId) params.set("id", recordId);
      if (section !== "overview" && !recordId) {
        if (query.search) params.set("search", query.search);
        if (query.after) params.set("after", query.after);
        params.set("limit", String(query.limit));
      }
      const response = await fetch(`/api/admin?${params}`, {
        cache: "no-store",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const raw: unknown = await response.json();
      if (!response.ok) {
        const parsed = adminErrorSchema.safeParse(raw);
        throw new Error(parsed.success ? parsed.data.error.code : "UNKNOWN");
      }
      if (section === "overview") {
        const parsed = adminContextSchema.safeParse(raw);
        if (!parsed.success) throw new Error("SCHEMA");
        return {
          context: parsed.data,
          page: null,
          error: null,
          loading: false,
        };
      } else {
        const parsed = adminPageSchema.safeParse(raw);
        if (!parsed.success || parsed.data.section !== section) throw new Error("SCHEMA");
        const contextResponse = await fetch("/api/admin?section=overview", {
          cache: "no-store", headers: { Authorization: `Bearer ${session.access_token}` },
        });
        const contextRaw: unknown = await contextResponse.json();
        if (!contextResponse.ok) {
          const failure = adminErrorSchema.safeParse(contextRaw);
          throw new Error(failure.success ? failure.data.error.code : "UNKNOWN");
        }
        const context = adminContextSchema.safeParse(contextRaw);
        if (!context.success) throw new Error("SCHEMA");
        return {
          context: context.data,
          page: parsed.data,
          error: null,
          loading: false,
        };
      }
    } catch (error) {
      return {
          context: null,
          page: null,
          error: errorText(
            error instanceof Error ? error.message : "UNKNOWN",
            t,
          ),
          loading: false,
        };
    }
  }, [query, recordId, section, session, t]);
  useEffect(() => {
    const generation = ++requestGeneration.current;
    void load().then(result => {
      if (result && generation === requestGeneration.current) setState(result);
    });
    return () => { requestGeneration.current += 1; };
  }, [load]);

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    if (!client) return;
    if (!credentials.email || !credentials.password) {
      setState((current) => ({ ...current, error: t.passwordRequired }));
      return;
    }
    setBusy(true);
    try {
      const { error } = await client.auth.signInWithPassword(credentials);
      if (error) setState((current) => ({ ...current, error: t.signInFailed }));
    } catch {
      setState((current) => ({ ...current, error: t.unavailable }));
    } finally { setBusy(false); }
  }
  async function github() {
    if (!client) return;
    setBusy(true);
    try {
      const { error } = await client.auth.signInWithOAuth({
        provider: "github",
        options: { redirectTo: adminOAuthRedirectUrl(window.location.origin, locale) },
      });
      if (error) setState(current => ({ ...current, error: t.signInFailed }));
    } catch {
      setState(current => ({ ...current, error: t.unavailable }));
    } finally { setBusy(false); }
  }
  async function signOut() {
    if (!client) return;
    setBusy(true);
    requestGeneration.current += 1;
    setState({ context: null, page: null, error: null, loading: false });
    try {
      const { error } = await client.auth.signOut({ scope: "local" });
      if (error) setState(current => ({ ...current, error: t.unavailable }));
      else setSession(null);
    } catch {
      setState(current => ({ ...current, error: t.unavailable }));
    } finally { setBusy(false); }
  }
  if (!session)
    return (
      <LoginForm
        locale={locale}
        section={section}
        recordId={recordId}
        query={query}
        configured={Boolean(client)}
        busy={busy}
        credentials={credentials}
        error={state.error}
        onChange={setCredentials}
        onGitHub={github}
        onSubmit={signIn}
        t={t}
      />
    );

  const navigate = (next: AdminSection) => {
    const path = adminNavigationPath(locale, next);
    if (path) window.location.assign(path);
  };
  const otherLocale = locale === "zh" ? "en" : "zh";
  const translatedRoute = recordId
    ? `/${otherLocale}/admin/${section}/${encodeURIComponent(recordId)}`
    : section === "overview"
      ? `/${otherLocale}/admin`
      : `/${otherLocale}/admin/${section}`;
  return (
    <Shell
      active={section}
      locale={locale}
      translatedRoute={`${translatedRoute}${recordId || section === "overview" ? "" : buildAdminQuery(query)}`}
      navigate={navigate}
      onSignOut={signOut}
      busy={busy}
      environment={state.context?.environment.name}
      t={t}
    >
      <div className="mb-6 text-sm text-foreground-muted">
        {t.breadcrumbs} / {t[section]}
      </div>
      {state.loading ? (
        <p className="text-sm text-foreground-muted">…</p>
      ) : state.error ? (
        <ErrorPanel text={state.error} />
      ) : section === "overview" && state.context ? (
        <Overview context={state.context} t={t} />
      ) : state.page ? (
        <Page
          page={state.page}
          recordId={recordId}
          locale={locale}
          query={query}
          onQuery={(next) => {
            setState(current => ({ ...current, loading: true, error: null }));
            window.history.replaceState(null, "", `${window.location.pathname}${buildAdminQuery(next)}`);
            setQuery(next);
          }}
          t={t}
        />
      ) : (
        <p className="text-sm text-foreground-muted">{t.empty}</p>
      )}
    </Shell>
  );
}

function LoginForm({
  locale,
  section,
  recordId,
  query,
  configured,
  busy,
  credentials,
  error,
  onChange,
  onGitHub,
  onSubmit,
  t,
}: {
  locale: "zh" | "en";
  section: AdminSection;
  recordId?: string;
  query: Query;
  configured: boolean;
  busy: boolean;
  credentials: { email: string; password: string };
  error: string | null;
  onChange: (value: { email: string; password: string }) => void;
  onGitHub: () => void;
  onSubmit: (event: React.FormEvent) => void;
  t: AdminMessages;
}) {
  const otherLocale = locale === "zh" ? "en" : "zh";
  const route = recordId
    ? `/${otherLocale}/admin/${section}/${encodeURIComponent(recordId)}`
    : section === "overview"
      ? `/${otherLocale}/admin`
      : `/${otherLocale}/admin/${section}${buildAdminQuery(query)}`;
  return (
    <main className="mx-auto min-h-screen max-w-md px-6 pt-5">
      <UtilityBar locale={locale} localeHref={route} t={t} />
      <section className="mt-16 space-y-5 rounded-xl border border-border bg-surface p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-accent" />
          <h1 className="text-xl font-semibold">{t.loginTitle}</h1>
        </div>
        <p className="text-sm text-foreground-muted">
          {configured ? t.loginHint : t.noConfiguration}
        </p>
        <form className="space-y-3" onSubmit={onSubmit}>
          <Input
            type="email"
            autoComplete="username"
            placeholder={t.email}
            value={credentials.email}
            onChange={(event) =>
              onChange({ ...credentials, email: event.target.value })
            }
          />
          <Input
            type="password"
            autoComplete="current-password"
            placeholder={t.password}
            value={credentials.password}
            onChange={(event) =>
              onChange({ ...credentials, password: event.target.value })
            }
          />
          {error && <p className="text-sm text-danger-foreground">{error}</p>}
          <Button className="w-full" disabled={busy || !configured}>
            <LogIn />
            {busy ? t.signingIn : t.signIn}
          </Button>
        </form>
        <Button
          variant="secondary"
          className="w-full"
          onClick={onGitHub}
          disabled={busy || !configured}
        >
          {t.github}
        </Button>
      </section>
    </main>
  );
}
function UtilityBar({
  locale,
  localeHref,
  t,
}: {
  locale: string;
  localeHref: string;
  t: AdminMessages;
}) {
  return (
    <div className="flex items-center justify-between">
      <a
        href={`/${locale}/`}
        rel="noreferrer"
        className="text-sm text-foreground-muted hover:text-foreground"
      >
        ← {t.backToEditor}
      </a>
      <div className="flex items-center gap-2">
        <a
          href={localeHref}
          className="rounded-md px-2 py-1 text-sm text-foreground-muted hover:bg-surface-hover"
        >
          {locale === "zh" ? "EN" : "中文"}
        </a>
        <ThemeToggle />
      </div>
    </div>
  );
}

function Shell({
  active,
  locale,
  translatedRoute,
  navigate,
  onSignOut,
  busy,
  environment,
  t,
  children,
}: {
  active: AdminSection;
  locale: string;
  translatedRoute: string;
  navigate: (section: AdminSection) => void;
  onSignOut: () => void;
  busy: boolean;
  environment?: string;
  t: AdminMessages;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border px-5 py-3">
        <a href={`/${locale}/admin`} className="font-semibold">
          {t.brand}
        </a>
        <div className="flex items-center gap-2">
          {environment && <span className="rounded border border-border px-2 py-1 text-xs font-semibold">{environment}</span>}
          <a
            href={translatedRoute}
            className="rounded-md px-2 py-1 text-sm text-foreground-muted hover:bg-surface-hover"
          >
            {locale === "zh" ? "EN" : "中文"}
          </a>
          <span className="rounded-full border border-border px-2 py-1 text-xs text-foreground-muted">
            {t.readOnly}
          </span>
          <ThemeToggle />
          <Button variant="ghost" size="sm" onClick={onSignOut} disabled={busy}>
            <LogOut />
            {busy ? t.signingOut : t.signOut}
          </Button>
        </div>
      </header>
      <nav className="border-b border-border p-3 md:hidden" aria-label={t.breadcrumbs}>
        <select className="w-full rounded border border-border bg-surface p-2" aria-label={t.breadcrumbs}
          value={active} onChange={event => navigate(event.target.value as AdminSection)}>
          {(["overview", "users", "profiles", "prices", "policies", "audit"] as const).map(section =>
            <option key={section} value={section}>{t[section]}</option>)}
        </select>
      </nav>
      <div className="mx-auto flex max-w-7xl">
        <aside className="hidden w-56 shrink-0 border-r border-border p-4 md:block">
          <a
            href={`/${locale}/`}
            rel="noreferrer"
            className="mb-5 block text-sm text-foreground-muted hover:text-foreground"
          >
            ← {t.backToEditor}
          </a>
          <nav className="space-y-1">
            <GroupLabel>{t.overview}</GroupLabel>
            <NavButton
              section="overview"
              active={active}
              navigate={navigate}
              t={t}
            />
            <GroupLabel>{t.users}</GroupLabel>
            <NavButton
              section="users"
              active={active}
              navigate={navigate}
              t={t}
            />
            <GroupLabel>{t.aiManagement}</GroupLabel>
            <NavButton
              section="profiles"
              active={active}
              navigate={navigate}
              t={t}
            />
            <NavButton
              section="prices"
              active={active}
              navigate={navigate}
              t={t}
            />
            <NavButton
              section="policies"
              active={active}
              navigate={navigate}
              t={t}
            />
            <GroupLabel>{t.audit}</GroupLabel>
            <NavButton
              section="audit"
              active={active}
              navigate={navigate}
              t={t}
            />
          </nav>
        </aside>
        <main className="min-w-0 flex-1 p-5 md:p-8">{children}</main>
      </div>
    </div>
  );
}
function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="mt-4 block px-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-foreground-subtle">
      {children}
    </span>
  );
}
function NavButton({
  section,
  active,
  navigate,
  t,
}: {
  section: AdminSection;
  active: AdminSection;
  navigate: (section: AdminSection) => void;
  t: AdminMessages;
}) {
  return (
    <button
      onClick={() => navigate(section)}
      className={`block w-full rounded-md px-3 py-2 text-left text-sm ${active === section ? "bg-surface-hover font-medium text-foreground" : "text-foreground-muted hover:bg-surface-hover"}`}
    >
      {t[section]}
    </button>
  );
}
function ErrorPanel({ text }: { text: string }) {
  return (
    <div className="rounded-md border border-danger-border bg-danger-soft p-4 text-sm text-danger-foreground">
      {text}
    </div>
  );
}

function Overview({ context, t }: { context: AdminContext; t: AdminMessages }) {
  const metrics = [
    [t.environment, context.environment.name],
    [t.callsDay, String(context.features.globalDailyLimit)],
    [t.allowlisted, String(context.features.allowlistedUsers)],
    [t.aiEnabled, context.features.aiEnabled ? t.enabled : t.disabled],
  ];
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t.overview}</h1>
        <p className="mt-1 text-sm text-foreground-muted">
          {context.environment.name} · {context.environment.projectRef}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {metrics.map(([label, value]) => (
          <div
            key={label}
            className="rounded-lg border border-border bg-surface p-4"
          >
            <p className="text-xs text-foreground-muted">{label}</p>
            <p className="mt-2 text-lg font-semibold">{value}</p>
          </div>
        ))}
      </div>
      <div className="rounded-lg border border-border bg-surface p-4 text-sm">
        <p>
          {t.activePolicy}: {context.features.activePolicyVersionId ?? "—"}
        </p>
        <p className="mt-2">
          {t.legalBundle}: {context.features.currentLegalBundle}
        </p>
        <p className="mt-2">
          {t.configRevision}: {context.features.configGeneration}
        </p>
      </div>
    </div>
  );
}

function Page({
  page,
  recordId,
  locale,
  query,
  onQuery,
  t,
}: {
  page: AdminPage;
  recordId?: string;
  locale: string;
  query: Query;
  onQuery: (query: Query) => void;
  t: AdminMessages;
}) {
  const [search, setSearch] = useState(query.search);
  const rows = page.items as Array<Record<string, unknown>>;
  if (recordId && rows[0])
    return (
      <Detail section={page.section} row={rows[0]} locale={locale} t={t} />
    );
  const fields = columns(page.section, t);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t[page.section]}</h1>
        <form className="flex gap-2" onSubmit={(event) => {
          event.preventDefault();
          onQuery({ ...query, search, after: "" });
        }}>
          <Input
            aria-label={t.search}
            placeholder={t.search}
            value={search}
            maxLength={100}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Button
            variant="secondary"
            size="sm"
            type="submit"
          >
            {t.apply}
          </Button>
        </form>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-foreground-muted">{t.empty}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-hover text-xs text-foreground-muted">
              <tr>
                {fields.map(([key, label]) => (
                  <th
                    key={key}
                    className="whitespace-nowrap px-4 py-3 font-medium"
                  >
                    {label}
                  </th>
                ))}
                <th className="px-4 py-3 font-medium">{t.actions}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={String(row.id)} className="border-t border-border">
                  {fields.map(([key]) => (
                    <td key={key} className="max-w-xs truncate px-4 py-3">
                      {localizedAdminValue(row[key], locale, t)}
                    </td>
                  ))}
                  <td className="px-4 py-3">
                    <a
                      className="text-accent-soft-foreground hover:underline"
                      href={`/${locale}/admin/${page.section}/${encodeURIComponent(String(row.id))}`}
                    >
                      {t.view}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page.nextCursor && (
        <Button
          variant="secondary"
          onClick={() => onQuery({ ...query, after: page.nextCursor ?? "" })}
        >
          {t.nextPage}
        </Button>
      )}
    </div>
  );
}

function Detail({
  section,
  row,
  locale,
  t,
}: {
  section: AdminRecordSection;
  row: Record<string, unknown>;
  locale: string;
  t: AdminMessages;
}) {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{t.details}</h1>
      <dl className="grid gap-3 sm:grid-cols-2">
        {detailLabels(section, t).map(([key, label]) => (
          <div
            key={key}
            className="rounded-lg border border-border bg-surface p-4"
          >
            <dt className="text-xs text-foreground-muted">{label}</dt>
            <dd className="mt-1 break-words text-sm">
              {localizedAdminValue(row[key], locale, t)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
function columns(
  section: AdminRecordSection,
  t: AdminMessages,
): Array<[string, string]> {
  if (section === "users")
    return [
      ["email", t.emailCol],
      ["isAdmin", t.admin],
      ["banned", t.banned],
      ["createdAt", t.createdAt],
    ];
  if (section === "profiles")
    return [
      ["profileKey", t.profiles],
      ["version", t.version],
      ["modelId", t.model],
      ["status", t.status],
      ["gatewayKind", t.gateway],
    ];
  if (section === "prices")
    return [
      ["currency", t.currency],
      ["calculatorKind", t.calculator],
      ["validFrom", t.validFrom],
      ["sealedAt", t.status],
    ];
  if (section === "policies")
    return [
      ["policyKey", t.policies],
      ["version", t.version],
      ["status", t.status],
      ["timezone", t.timezone],
      ["legalBundleVersion", t.legalBundle],
    ];
  return [
    ["occurredAt", t.occurredAt],
    ["source", t.source],
    ["operation", t.operation],
    ["actor", t.actor],
    ["reason", t.reason],
  ];
}
function detailLabels(
  section: AdminRecordSection,
  t: AdminMessages,
): Array<[string, string]> {
  if (section === "users")
    return [
      ["id", t.id],
      ["email", t.emailCol],
      ["createdAt", t.createdAt],
      ["isAdmin", t.admin],
      ["revision", t.configRevision],
      ["banned", t.banned],
    ];
  if (section === "profiles")
    return [
      ["id", t.id],
      ["profileId", t.profileId],
      ["profileKey", t.profileKey],
      ["version", t.version],
      ["status", t.status],
      ["gatewayKind", t.gateway],
      ["adapterKind", t.adapter],
      ["wireApiKind", t.wireApi],
      ["modelId", t.model],
      ["legalManifestId", t.legalManifest],
      ["displayDisclosureKey", t.displayDisclosure],
      ["endpointAlias", t.endpointAlias],
      ["credentialAlias", t.credentialAlias],
      ["endpointUrl", t.endpoint],
      ["credentialEnvName", t.credentialEnv],
      ["configSha256", t.configHash],
      ["createdAt", t.createdAt],
    ];
  if (section === "prices")
    return [
      ["id", t.id],
      ["profileVersionId", t.profileVersion],
      ["currency", t.currency],
      ["calculatorKind", t.calculator],
      ["validFrom", t.validFrom],
      ["validTo", t.validTo],
      ["sealedAt", t.sealedAt],
      ["createdAt", t.createdAt],
    ];
  if (section === "policies")
    return [
      ["id", t.id],
      ["policyKey", t.policyKey],
      ["version", t.version],
      ["status", t.status],
      ["timezone", t.timezone],
      ["defaultProfileVersionId", t.defaultProfile],
      ["legalBundleVersion", t.legalBundle],
      ["runtimeContractId", t.runtimeContract],
      ["configSha256", t.configHash],
      ["createdAt", t.createdAt],
    ];
  return [
    ["id", t.id],
    ["occurredAt", t.occurredAt],
    ["source", t.source],
    ["operation", t.operation],
    ["actor", t.actor],
    ["targetId", t.targetId],
    ["reason", t.reason],
  ];
}
