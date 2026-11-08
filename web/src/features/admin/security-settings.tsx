"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AdminMessages } from "./messages";
type Factor = {
  id: string;
  friendly_name?: string | null;
  factor_type: string;
  status: string;
};
type Enrollment = {
  id: string;
  secret: string;
  uri: string;
  qrCode: string;
};
export function AdminSecuritySettings({
  client,
  t
}: {
  client: SupabaseClient;
  t: AdminMessages;
}) {
  const [factors, setFactors] = useState<Factor[]>([]);
  const [aal, setAal] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState("");
  const [selectedFactor, setSelectedFactor] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const mounted = useRef(true);
  const refresh = useCallback(async (clearMessage = true) => {
    setBusy(true);
    if (clearMessage) setMessage(null);
    try {
      const [{
        data,
        error
      }, assurance] = await Promise.all([client.auth.mfa.listFactors(), client.auth.mfa.getAuthenticatorAssuranceLevel()]);
      if (!mounted.current) return;
      if (error) throw error;
      setFactors((data?.all ?? []).map(factor => ({
        id: factor.id,
        friendly_name: factor.friendly_name,
        factor_type: factor.factor_type,
        status: factor.status
      })));
      setAal(assurance.data?.currentLevel ?? null);
    } catch {
      if (!mounted.current) return;
      setMessage(t.securityUnavailable);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [client, t.securityUnavailable]);
  useEffect(() => {
    mounted.current = true;
    queueMicrotask(() => {
      if (mounted.current) void refresh();
    });
    return () => {
      mounted.current = false;
    };
  }, [refresh]);
  async function enroll() {
    setBusy(true);
    setMessage(null);
    try {
      const {
        data,
        error
      } = await client.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: "Admin TOTP"
      });
      if (error || !data?.id || !data.totp?.secret || !data.totp.uri || !data.totp.qr_code) {
        throw error ?? new Error("invalid enrollment response");
      }
      setEnrollment({
        id: data.id,
        secret: data.totp.secret,
        uri: data.totp.uri,
        qrCode: data.totp.qr_code
      });
      setMessage(t.enrollmentReady);
    } catch {
      setMessage(t.securityUnavailable);
    } finally {
      setBusy(false);
    }
  }
  async function verify() {
    const factorId = enrollment?.id || selectedFactor || factors.find(factor => factor.factor_type === "totp" && factor.status === "verified")?.id;
    if (!factorId || !/^\d{6}$/.test(code)) {
      setMessage(t.invalidTotp);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const challenge = await client.auth.mfa.challenge({
        factorId
      });
      if (challenge.error || !challenge.data?.id) throw challenge.error ?? new Error("challenge failed");
      const result = await client.auth.mfa.verify({
        factorId,
        challengeId: challenge.data.id,
        code
      });
      if (result.error) throw result.error;
      setEnrollment(null);
      setCode("");
      setMessage(t.verified);
      await client.auth.refreshSession();
      await refresh(false);
    } catch {
      setMessage(t.invalidTotp);
    } finally {
      setBusy(false);
    }
  }
  async function unenroll(factorId: string) {
    setBusy(true);
    setMessage(null);
    try {
      const {
        error
      } = await client.auth.mfa.unenroll({
        factorId
      });
      if (error) throw error;
      setEnrollment(null);
      setCode("");
      setMessage(t.unenrolled);
      await client.auth.refreshSession();
      await refresh(false);
    } catch {
      setMessage(t.securityUnavailable);
    } finally {
      setBusy(false);
    }
  }
  return <section className="min-w-0 space-y-4 rounded-lg border border-border bg-surface p-4">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="break-words font-semibold">{t.securityTitle}</h2>
          <p className="break-words text-sm text-foreground-muted">{t.securityHint}</p>
        </div>
        <Button className="h-auto min-h-9 max-w-full whitespace-normal py-2" variant="secondary" size="sm" onClick={() => void refresh()} disabled={busy}>
          {t.refreshSecurity}
        </Button>
      </div>
      <p className="break-words text-sm">{t.assurance}: {aal ?? "—"}</p>
      {factors.length > 0 ? <ul className="min-w-0 space-y-2 text-sm">
          {factors.map(factor => <li key={factor.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded border border-border p-3">
              <span className="min-w-0 break-words">{factor.friendly_name || t.totp} · {factor.status}</span>
              <Button className="h-auto min-h-9 max-w-full whitespace-normal py-2" variant="ghost" size="sm" onClick={() => void unenroll(factor.id)} disabled={busy}>
                {t.unenroll}
              </Button>
            </li>)}
        </ul> : <p className="break-words text-sm text-foreground-muted">{t.noFactors}</p>}
      {!enrollment && <Button className="h-auto min-h-9 max-w-full whitespace-normal py-2" variant="secondary" onClick={() => void enroll()} disabled={busy}>
          {t.enrollTotp}
        </Button>}
      {enrollment && <div className="min-w-0 space-y-3 rounded border border-border p-3">
          <p className="break-words text-sm">{t.scanQr}</p>
          <Image src={enrollment.qrCode} alt={t.qrCode} width={160} height={160} unoptimized className="h-auto w-40 max-w-full rounded bg-white p-2" />
          <p className="min-w-0 break-all text-xs text-foreground-muted">{t.secret}: {enrollment.secret}</p>
          <p className="min-w-0 break-all text-xs text-foreground-muted">{t.manualUri}: {enrollment.uri}</p>
          <div className="flex min-w-0 flex-wrap items-start gap-2">
            <Input className="min-w-0 max-w-full flex-[1_1_10rem]" inputMode="numeric" autoComplete="one-time-code" aria-label={t.totpCode} maxLength={6} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} />
            <Button className="h-auto min-h-9 max-w-full whitespace-normal py-2" onClick={() => void verify()} disabled={busy || code.length !== 6}>
              {t.verifyTotp}
            </Button>
          </div>
        </div>}
      {!enrollment && factors.some(factor => factor.factor_type === "totp" && factor.status === "verified") && <div className="flex min-w-0 flex-wrap items-start gap-2">
          <select aria-label={t.totp} value={selectedFactor || factors.find(factor => factor.factor_type === "totp" && factor.status === "verified")?.id} onChange={event => setSelectedFactor(event.target.value)} className="min-w-0 max-w-full flex-[1_1_10rem] rounded border border-border bg-bg p-2">
            {factors.filter(factor => factor.factor_type === "totp" && factor.status === "verified").map(factor => <option key={factor.id} value={factor.id}>{factor.friendly_name || t.totp}</option>)}
          </select>
          <Input className="min-w-0 max-w-full flex-[1_1_10rem]" inputMode="numeric" autoComplete="one-time-code" aria-label={t.totpCode} maxLength={6} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} />
          <Button className="h-auto min-h-9 max-w-full whitespace-normal py-2" onClick={() => void verify()} disabled={busy || code.length !== 6}>{t.verifyTotp}</Button>
        </div>}
      {message && <p className="break-words text-sm text-foreground-muted" role="status">{message}</p>}
    </section>;
}
