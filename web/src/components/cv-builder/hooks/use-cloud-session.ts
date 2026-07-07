import type { Session } from "@supabase/supabase-js";
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export type CloudStatus = "idle" | "loading" | "ready" | "error";

function readAuthRedirectError() {
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  const searchParams = new URLSearchParams(window.location.search);
  const description = hashParams.get("error_description") ?? searchParams.get("error_description");
  const error = hashParams.get("error") ?? searchParams.get("error");

  return description ?? error;
}

export function useCloudSession({ onError }: { onError: (message: string) => void }) {
  const [supabase] = useState(() => getSupabaseBrowserClient());
  const [session, setSession] = useState<Session | null>(null);
  const [sessionInitialized, setSessionInitialized] = useState(() => !supabase);
  const [cloudStatus, setCloudStatus] = useState<CloudStatus>("idle");

  useEffect(() => {
    if (!supabase) {
      return;
    }

    const client = supabase;
    let cancelled = false;

    async function loadInitialSession() {
      const redirectError = readAuthRedirectError();
      if (redirectError) {
        setCloudStatus("error");
        onError(redirectError);
      }

      const { data, error } = await client.auth.getSession();
      if (cancelled) {
        return;
      }

      setSessionInitialized(true);
      if (error) {
        setCloudStatus("error");
        onError(error.message);
        return;
      }

      setSession(data.session);
    }

    void loadInitialSession();

    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((_event, nextSession) => {
      setSessionInitialized(true);
      setSession(nextSession);
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
    supabase,
  };
}
