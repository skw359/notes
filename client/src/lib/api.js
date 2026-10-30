// Single place where the client talks to the server. Errors carry the
// server's stable `code`, and a 401 is broadcast so the app can ask for the
// password again instead of silently failing saves (DATA-2).
export class ApiError extends Error {
  constructor({ status, code, message, data = null, retryAfterMs = null }) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.data = data
    this.retryAfterMs = retryAfterMs
  }
}

const listeners = new Set()

export function onApiEvent(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emit(event) {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      // a listener's failure must not break the request that triggered it
    }
  }
}

const DEFAULT_MESSAGES = {
  400: 'The server rejected the request',
  401: 'Your session has expired. Sign in again to continue.',
  403: 'You are not allowed to do that',
  404: 'Not found',
  409: 'This changed somewhere else',
  413: 'This is larger than the server allows',
  429: 'Too many requests. Please wait a moment.',
}

async function parseJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function parseRetryAfter(response) {
  const value = Number(response.headers.get('retry-after'))
  return Number.isFinite(value) && value > 0 ? value * 1000 : null
}

export async function apiRequest(path, { method = 'GET', json, body, headers = {}, signal, raw = false, fetchImpl = globalThis.fetch } = {}) {
  let response
  try {
    response = await fetchImpl(path, {
      method,
      credentials: 'include',
      signal,
      headers: { ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : body,
    })
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw error
    }
    throw new ApiError({ status: 0, code: 'NETWORK', message: 'The server could not be reached' })
  }

  if (response.ok && raw) {
    return response
  }

  const data = await parseJson(response)
  if (!response.ok) {
    const code = data?.code || (response.status === 401 ? 'AUTH_REQUIRED' : `HTTP_${response.status}`)
    const error = new ApiError({
      status: response.status,
      code,
      message: data?.error || DEFAULT_MESSAGES[response.status] || `Request failed (${response.status})`,
      data,
      retryAfterMs: parseRetryAfter(response),
    })
    if (response.status === 401 && !path.startsWith('/api/auth/login') && !path.startsWith('/api/auth/prelogin')) {
      emit({ type: 'unauthorized', code })
    }
    throw error
  }
  return data
}

// `fetchImpl` lets tests run the real client against a real server with a
// per-"device" cookie jar.
export function createApiClient({ fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  const request = (path, options = {}) => apiRequest(path, { ...options, fetchImpl })
  return {
    request,
    get: (path, options) => request(path, options),
    post: (path, json, options) => request(path, { ...options, method: 'POST', json }),
    put: (path, json, options) => request(path, { ...options, method: 'PUT', json }),
    patch: (path, json, options) => request(path, { ...options, method: 'PATCH', json }),
    delete: (path, json, options) => request(path, { ...options, method: 'DELETE', json }),
  }
}

export const api = createApiClient()

// Worth retrying later without user action (offline, server restarting,
// rate limited). Everything else needs a decision.
export function isRetryable(error) {
  return (
    error instanceof ApiError &&
    (error.status === 0 || error.status === 429 || error.status === 500 || error.status === 502 ||
      error.status === 503 || error.status === 504)
  )
}
