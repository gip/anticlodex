import {
  composeChangesSubmission,
  fetchOpenShip,
  validateChangesAccepted,
  validateChangesStatus,
  validateSources,
  type DiscoveryDocument,
  type SourcesBundle,
  type SourcesManifest,
} from "@openship/protocol";

export type OpenShipApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface OpenShipHeaderAdapter {
  headersFor(input: { url: string; method: "GET" | "POST"; response?: Response }): Promise<HeadersInit | undefined>;
}

export interface OpenShipRemoteChange {
  remoteChangeId: string | null;
  baseDigest: string;
  resultDigest: string;
  submitUrl: string;
  statusUrl: string | null;
  candidateOrigin: string | null;
  status: "pending" | "processing" | "ready" | "rejected" | "failed" | "unsupported";
  phase: string | null;
  response: unknown;
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { return { message: text }; }
}

async function persistRemoteChange(apiFetch: OpenShipApiFetch, projectPath: string, change: OpenShipRemoteChange): Promise<void> {
  const response = await apiFetch(`${projectPath}/openship/remote-changes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(change),
  });
  if (!response.ok) throw new Error("The provider response could not be persisted in Anticlodex.");
}

function changesCapability(discovery: DiscoveryDocument): { submit: string; status: string } {
  const changes = discovery.capabilities.changes;
  if (!changes) throw new Error("This origin does not advertise the Changes capability.");
  return { submit: changes.submit, status: changes.status };
}

function remoteStatus(value: unknown): Exclude<OpenShipRemoteChange["status"], "unsupported"> {
  if (["pending", "processing", "ready", "rejected", "failed"].includes(String(value))) {
    return value as Exclude<OpenShipRemoteChange["status"], "unsupported">;
  }
  throw new Error("The provider returned an invalid Changes status.");
}

export async function submitOpenShipChanges(input: {
  apiFetch: OpenShipApiFetch;
  projectPath: string;
  discovery: DiscoveryDocument;
  title: string;
  intent: string;
  adapter?: OpenShipHeaderAdapter;
}): Promise<OpenShipRemoteChange> {
  const [upstreamResponse, manifestResponse, bundleResponse] = await Promise.all([
    input.apiFetch(`${input.projectPath}/openship/upstream.json`),
    input.apiFetch(`${input.projectPath}/openship/manifest.json`),
    input.apiFetch(`${input.projectPath}/openship/bundle.json`),
  ]);
  if (!upstreamResponse.ok || !manifestResponse.ok || !bundleResponse.ok) throw new Error("Current and upstream OpenShip Sources could not be loaded.");
  const upstream = await upstreamResponse.json() as { manifest: SourcesManifest; bundle: SourcesBundle };
  const currentManifest = await manifestResponse.json() as SourcesManifest;
  const currentBundle = await bundleResponse.json() as SourcesBundle;
  const base = validateSources(upstream.manifest, upstream.bundle);
  const current = validateSources(currentManifest, currentBundle);
  const submission = composeChangesSubmission(base, current, { title: input.title, intent: input.intent });
  if (Object.keys(submission.files as Record<string, unknown>).length === 0) throw new Error("There are no source changes to submit.");
  const capability = changesCapability(input.discovery);
  const headers = new Headers({ "Content-Type": "application/json", Accept: "application/json" });
  const adapted = await input.adapter?.headersFor({ url: capability.submit, method: "POST" });
  new Headers(adapted).forEach((value, key) => headers.set(key, value));
  const providerResponse = await fetch(capability.submit, { method: "POST", headers, body: JSON.stringify(submission), credentials: "omit" });
  const body = await responseBody(providerResponse);
  if ([401, 402, 403].includes(providerResponse.status)) {
    const unsupported: OpenShipRemoteChange = {
      remoteChangeId: null, baseDigest: base.manifest.digest, resultDigest: current.manifest.digest,
      submitUrl: capability.submit, statusUrl: null, candidateOrigin: null, status: "unsupported",
      phase: `http_${providerResponse.status}`, response: body,
    };
    await persistRemoteChange(input.apiFetch, input.projectPath, unsupported);
    return unsupported;
  }
  if (!providerResponse.ok) throw new Error(`Changes submission failed with HTTP ${providerResponse.status}.`);
  const accepted = validateChangesAccepted(body) as Record<string, unknown>;
  if (accepted.digest !== current.manifest.digest) throw new Error("The provider accepted a different resulting Sources digest.");
  const remoteChangeId = String(accepted.changeId ?? "");
  if (!remoteChangeId) throw new Error("The Changes response omitted changeId.");
  const change: OpenShipRemoteChange = {
    remoteChangeId, baseDigest: base.manifest.digest, resultDigest: current.manifest.digest,
    submitUrl: capability.submit,
    statusUrl: typeof accepted.statusUrl === "string" ? accepted.statusUrl : capability.status.replace("{changeId}", encodeURIComponent(remoteChangeId)),
    candidateOrigin: typeof accepted.candidateOrigin === "string" ? accepted.candidateOrigin : null,
    status: remoteStatus(accepted.status),
    phase: typeof accepted.phase === "string" ? accepted.phase : null,
    response: body,
  };
  await persistRemoteChange(input.apiFetch, input.projectPath, change);
  return change;
}

export async function pollOpenShipChange(input: {
  apiFetch: OpenShipApiFetch;
  projectPath: string;
  change: OpenShipRemoteChange;
  adapter?: OpenShipHeaderAdapter;
}): Promise<OpenShipRemoteChange> {
  if (!input.change.statusUrl) throw new Error("This Changes record has no public status URL.");
  const headers = new Headers({ Accept: "application/json" });
  const adapted = await input.adapter?.headersFor({ url: input.change.statusUrl, method: "GET" });
  new Headers(adapted).forEach((value, key) => headers.set(key, value));
  const response = await fetch(input.change.statusUrl, { headers, credentials: "omit" });
  const body = await responseBody(response);
  let next: OpenShipRemoteChange;
  if ([401, 402, 403].includes(response.status)) {
    next = { ...input.change, status: "unsupported", phase: `http_${response.status}`, response: body };
  } else {
    if (!response.ok) throw new Error(`Changes status failed with HTTP ${response.status}.`);
    const status = validateChangesStatus(body) as Record<string, unknown>;
    if (status.digest !== input.change.resultDigest) throw new Error("The Changes status digest does not match the submitted result.");
    next = {
      ...input.change,
      status: remoteStatus(status.status),
      phase: typeof status.phase === "string" ? status.phase : null,
      candidateOrigin: typeof status.candidateOrigin === "string" ? status.candidateOrigin : input.change.candidateOrigin,
      response: body,
    };
    if (next.status === "ready") {
      if (!next.candidateOrigin) throw new Error("A ready Changes response omitted candidateOrigin.");
      const candidate = await fetchOpenShip(next.candidateOrigin, { preferSystems: false });
      if (candidate.verified.manifest.digest !== next.resultDigest) throw new Error("The ready candidate advertises a different Sources digest.");
    }
  }
  await persistRemoteChange(input.apiFetch, input.projectPath, next);
  return next;
}
