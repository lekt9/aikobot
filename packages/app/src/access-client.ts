/** Adapts the Access SDK to the application's authenticated transport and its active server binding. */
import { AccessClientError, createAccessClient } from "access/client";

export interface AccessAppTransport {
  getBaseUrl(): string;
  getRestAuthToken(): string | null;
  getAuthorityRevision(): number;
  rawRequest(
    path: string,
    init?: RequestInit,
    options?: {
      allowNonOk?: boolean;
      skipResume?: boolean;
      boundAuthorityRevision?: number;
    },
  ): Promise<Response>;
}

export function createAccessAppClient(
  transport: AccessAppTransport,
  origin: string,
) {
  const server = new URL(transport.getBaseUrl() || origin, origin).href.replace(
    /\/$/,
    "",
  );
  const baseUrl = `${server}/access`;
  const authority = transport.getAuthorityRevision();
  const assertAuthority = () => {
    const current = new URL(
      transport.getBaseUrl() || origin,
      origin,
    ).href.replace(/\/$/, "");
    if (current !== server || transport.getAuthorityRevision() !== authority)
      throw new AccessClientError("conflict", 409);
  };
  return createAccessClient({
    baseUrl,
    token: () => {
      assertAuthority();
      const token = transport.getRestAuthToken();
      if (!token) throw new AccessClientError("unauthorized", 401);
      return token;
    },
    fetch: async (input, init) => {
      assertAuthority();
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      if (!url.href.startsWith(`${baseUrl}/`))
        throw new AccessClientError("invalid_request", 400);
      const path = `/access${url.href.substring(baseUrl.length)}`;
      // The app transport owns its bearer and CSRF headers. Forwarding the SDK
      // bearer too can combine differently cased Authorization keys on the wire.
      const headers = new Headers(init?.headers);
      headers.delete("authorization");
      const response = await transport.rawRequest(
        path,
        { ...init, headers },
        {
          allowNonOk: true,
          skipResume: true,
          boundAuthorityRevision: authority,
        },
      );
      assertAuthority();
      return response;
    },
  });
}
