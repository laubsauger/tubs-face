export async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

export async function postJson<TRequest, TResponse>(path: string, payload?: TRequest): Promise<TResponse> {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });

  const json = await response.json() as TResponse & { error?: string };
  if (!response.ok) {
    throw new Error(typeof json === 'object' && json && 'error' in json ? String(json.error || `${response.status} ${response.statusText}`) : `${response.status} ${response.statusText}`);
  }

  return json;
}
