import { requireAppContext } from "@/lib/supabase/app-context";
import type { Session } from "@supabase/supabase-js";
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { clearUserEncryptionPasswords } from "@/lib/cv/encryption-storage";
export type CloudStatus = "idle" | "loading" | "ready" | "error";
function readAuthRedirectError() {
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  const searchParams = new URLSearchParams(window.location.search);
  const description = hashParams.get("error_description") ?? searchParams.get("error_description");
  const error = hashParams.get("error") ?? searchParams.get("error");
  return description ?? error;
}
export function useCloudSession({
  onError
}: {
  onError: (message: string) => void;
}) {
  const [supabase] = useState(() => getSupabaseBrowserClient());
  const [session, setSession] = useState<Session | null>(null);
  const [sessionInitialized, setSessionInitialized] = useState(() => !supabase);
  const [cloudStatus, setCloudStatus] = useState<CloudStatus>("idle");
  const currentUserId = useRef<string | null>(null);
  useEffect(() => {
    if (!supabase) {
      return;
    }
    const client = supabase;
    let cancelled = false;
    let authRevision = 0;
    function adoptSession(nextSession: Session | null) {
      const nextUserId = nextSession?.user.id ?? null;
      if (currentUserId.current !== nextUserId) {
        if (currentUserId.current) {
          // Each tab owns its sessionStorage. Peer-tab sign-out and direct
          // account switches must revoke this tab's passwords synchronously.
          clearUserEncryptionPasswords(currentUserId.current);
        }
        setCloudStatus("idle");
      }
      currentUserId.current = nextUserId;
      setSessionInitialized(true);
      setSession(nextSession);
    }
    async function loadInitialSession() {
      const redirectError = readAuthRedirectError();
      if (redirectError) {
        setCloudStatus("error");
        onError(redirectError);
      }
      const startingRevision = authRevision;
      const {
        data,
        error
      } = await client.auth.getSession();
      if (cancelled || authRevision !== startingRevision) {
        return;
      }
      setSessionInitialized(true);
      if (error) {
        setCloudStatus("error");
        onError(error.message);
        return;
      }
      try {
        if (data.session) await requireAppContext(client);
      } catch (error) {
        if (!cancelled && authRevision === startingRevision) {
          setCloudStatus("error");
          onError(error instanceof Error ? error.message : "Database unavailable");
        }
        return;
      }
      if (cancelled || authRevision !== startingRevision) return;
      adoptSession(data.session);
    }
    void loadInitialSession();
    const {
      data: {
        subscription
      }
    } = client.auth.onAuthStateChange((_event, nextSession) => {
      if (cancelled) return;
      authRevision += 1;
      adoptSession(nextSession);
    });
    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [onError, supabase]);
  return {
    cloudStatus,
    session,
    sessionInitialized,
    setCloudStatus: setCloudStatus as Dispatch<SetStateAction<CloudStatus>>,
    supabase
  };
}
