"use client";

import { useEffect, useState } from "react";
import { api } from "@/components/api";

export function useRemote<T>(path: string | null) {
  const [version, setVersion] = useState(0);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(path !== null);

  useEffect(() => {
    if (!path) return;
    let active = true;
    api<T>(path).then(
      (next) => {
        if (!active) return;
        setData(next);
        setError(null);
        setPending(false);
      },
      (reason: unknown) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : "加载失败");
        setPending(false);
      },
    );
    return () => {
      active = false;
    };
  }, [path, version]);

  return {
    data,
    error,
    loading: Boolean(path) && pending && !data && !error,
    reload() {
      setError(null);
      setPending(true);
      setVersion((current) => current + 1);
    },
  };
}
