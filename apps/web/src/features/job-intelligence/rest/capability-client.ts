import { restCapabilityFailureSchema } from "../contracts";
import type { RestCapabilityFailure } from "../contracts";

export type CapabilityFailureBody = RestCapabilityFailure;

export class CapabilityRequestError extends Error {
  readonly body: CapabilityFailureBody;
  readonly status: number;

  constructor(status: number, body: CapabilityFailureBody) {
    super(body.error.message);
    this.name = "CapabilityRequestError";
    this.status = status;
    this.body = body;
  }
}

export interface CapabilityClientOptions {
  readonly baseUrl: string;
}

export interface CapabilityRequestOptions {
  readonly headers?: HeadersInit;
  readonly signal?: AbortSignal;
}

export interface CapabilityJsonObject {
  readonly [key: string]: CapabilityJsonValue | undefined;
}

export type CapabilityJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly string[]
  | CapabilityJsonObject;

const parseJsonResponse = async <T>(response: Response): Promise<T> => {
  const raw: unknown = await response.json();
  if (!response.ok) {
    const parsedFailure = restCapabilityFailureSchema.safeParse(raw);
    const body = parsedFailure.success
      ? parsedFailure.data
      : {
          error: {
            code: "INTERNAL_ERROR",
            message: "Onverwacht antwoord van de capability-API.",
          },
        };
    throw new CapabilityRequestError(response.status, body);
  }
  // SAFETY: Callers pass the expected REST envelope type for each capability route.
  return raw as T;
};

const mergeHeaders = (extra?: HeadersInit): Headers => {
  const headers = new Headers({ Accept: "application/json" });
  if (!extra) {
    return headers;
  }
  for (const [key, value] of new Headers(extra).entries()) {
    headers.set(key, value);
  }
  return headers;
};

export const createCapabilityClient = (options: CapabilityClientOptions) => {
  const baseUrl = options.baseUrl.replace(/\/$/u, "");

  return {
    delete: async <T>(path: string): Promise<T> => {
      const response = await fetch(`${baseUrl}${path}`, {
        credentials: "include",
        headers: mergeHeaders(),
        method: "DELETE",
      });
      return parseJsonResponse<T>(response);
    },

    get: async <T>(
      path: string,
      requestOptions: CapabilityRequestOptions = {}
    ): Promise<T> => {
      const response = await fetch(`${baseUrl}${path}`, {
        credentials: "include",
        headers: mergeHeaders(requestOptions.headers),
        method: "GET",
        signal: requestOptions.signal,
      });
      return parseJsonResponse<T>(response);
    },

    post: async <T>(path: string, body: CapabilityJsonObject): Promise<T> => {
      const response = await fetch(`${baseUrl}${path}`, {
        body: JSON.stringify(body),
        credentials: "include",
        headers: mergeHeaders({
          "Content-Type": "application/json",
        }),
        method: "POST",
      });
      return parseJsonResponse<T>(response);
    },
  };
};

export type CapabilityClient = ReturnType<typeof createCapabilityClient>;
