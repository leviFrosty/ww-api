import type { AppContext, ErrorResponse } from './types';
import { HERE_API, HTTP_STATUS } from './config';
import { ContentfulStatusCode } from 'hono/utils/http-status';
import { Sentry } from './sentry';

function extractQueryParameters(requestUrl: string): URLSearchParams {
  const url = new URL(requestUrl);
  return new URLSearchParams(url.search);
}

function sanitizeAndInjectApiKey(params: URLSearchParams, apiKey: string): URLSearchParams {
  params.delete(HERE_API.API_KEY_PARAM);
  params.set(HERE_API.API_KEY_PARAM, apiKey);
  return params;
}

function buildHereApiUrl(baseUrl: string, params: URLSearchParams): string {
  return `${baseUrl}?${params.toString()}`;
}

async function fetchFromHereApi(url: string): Promise<Response> {
  return fetch(url);
}

/** Returns the parsed body, or `undefined` when it is not valid JSON. */
async function parseJsonBody(response: Response): Promise<unknown> {
  const body = await response.text();
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

export async function proxyRequestToHereApi(context: AppContext, hereApiBaseUrl: string) {
  try {
    const queryParams = extractQueryParameters(context.req.url);
    const sanitizedParams = sanitizeAndInjectApiKey(queryParams, context.env.HERE_API_KEY);
    const hereApiUrl = buildHereApiUrl(hereApiBaseUrl, sanitizedParams);

    const hereApiResponse = await fetchFromHereApi(hereApiUrl);
    const responseData = await parseJsonBody(hereApiResponse);

    if (responseData === undefined) {
      // HERE sits behind Cloudflare, so its outages surface as plain-text
      // `error code: 52x` pages rather than JSON. Report the upstream status as
      // one grouped warning instead of a SyntaxError per request.
      Sentry.captureMessage('HERE API returned a non-JSON response', {
        level: 'warning',
        fingerprint: ['here-api-non-json-response'],
        tags: { 'here_api.status': hereApiResponse.status },
      });

      const errorResponse: ErrorResponse = { error: 'Upstream error' };
      return context.json(errorResponse, HTTP_STATUS.BAD_GATEWAY);
    }

    return context.json(responseData, hereApiResponse.status as ContentfulStatusCode);
  } catch (error) {
    Sentry.captureException(error);

    const errorResponse: ErrorResponse = { error: 'Proxy error' };
    return context.json(errorResponse, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}
