export async function adminRequest<T>(pathname: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(pathname, {
    ...options,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const result = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(result.error ?? `Administration request failed (${response.status})`);
  return result as T;
}
