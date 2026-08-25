// Typed errors the integration layer throws so HTTP callers can answer with the
// right status and a message a user can act on, instead of a bare 500.

export type IntegrationErrorProvider = "notion" | "google";

export interface ProviderApiError extends Error {
  code: "PROVIDER_API_ERROR";
  provider: IntegrationErrorProvider;
  status: number;
  reason: string;
  statusText: string;
  responseBody?: string;
  requestUrl?: string;
}

export interface InvalidSourceUrlError extends Error {
  code: "INVALID_SOURCE_URL";
  provider: IntegrationErrorProvider;
  reason: string;
}

export interface IntegrationNotConfiguredError extends Error {
  code: "INTEGRATION_NOT_CONFIGURED";
  provider: IntegrationErrorProvider;
  reason: string;
  missing: string;
}

export function createProviderApiError(
  provider: IntegrationErrorProvider,
  init: {
    status: number;
    statusText: string;
    reason: string;
    responseBody?: string;
    requestUrl?: string;
  },
): ProviderApiError {
  const error = new Error(`${provider} API request failed: ${init.status} ${init.reason}`) as ProviderApiError;
  error.code = "PROVIDER_API_ERROR";
  error.provider = provider;
  error.status = init.status;
  error.statusText = init.statusText;
  error.reason = init.reason;
  error.responseBody = init.responseBody;
  error.requestUrl = init.requestUrl;
  return error;
}

export function isProviderApiError(value: unknown): value is ProviderApiError {
  return typeof value === "object"
    && value !== null
    && (value as { code?: string }).code === "PROVIDER_API_ERROR";
}

export function createInvalidSourceUrlError(
  provider: IntegrationErrorProvider,
  reason: string,
): InvalidSourceUrlError {
  const error = new Error(reason) as InvalidSourceUrlError;
  error.code = "INVALID_SOURCE_URL";
  error.provider = provider;
  error.reason = reason;
  return error;
}

export function isInvalidSourceUrlError(value: unknown): value is InvalidSourceUrlError {
  return typeof value === "object"
    && value !== null
    && (value as { code?: string }).code === "INVALID_SOURCE_URL";
}

export function createIntegrationNotConfiguredError(
  provider: IntegrationErrorProvider,
  missing: string,
): IntegrationNotConfiguredError {
  const reason = `${provider} is not configured on this server (${missing} is missing).`;
  const error = new Error(reason) as IntegrationNotConfiguredError;
  error.code = "INTEGRATION_NOT_CONFIGURED";
  error.provider = provider;
  error.reason = reason;
  error.missing = missing;
  return error;
}

export function isIntegrationNotConfiguredError(value: unknown): value is IntegrationNotConfiguredError {
  return typeof value === "object"
    && value !== null
    && (value as { code?: string }).code === "INTEGRATION_NOT_CONFIGURED";
}
