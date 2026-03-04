import { templateWebserverPostgresAuth0GoogleVercel } from "./template-webserver-postgres-auth0-google-vercel.js";
import { templateStaffxOpenShipBundleImport } from "./template-self-import.js";

export interface DefaultConcern {
  name: string;
  position: number;
  isBaseline: boolean;
}

export const DEFAULT_CONCERNS: DefaultConcern[] = [
  { name: "Features", position: 1, isBaseline: false },
  { name: "Interfaces", position: 2, isBaseline: false },
  { name: "Connectivity", position: 3, isBaseline: false },
  { name: "Security", position: 4, isBaseline: false },
  { name: "Data Model", position: 5, isBaseline: false },
  { name: "General Specs", position: 6, isBaseline: false },
  { name: "General Skills", position: 7, isBaseline: false },
  { name: "Implementation", position: 8, isBaseline: false },
  { name: "Deployment", position: 9, isBaseline: false },
  { name: "Functional Testing", position: 10, isBaseline: false },
];

export const BLANK_TEMPLATE_ID = "blank" as const;
export type NonBlankTemplateId =
  | "webserver-postgres-auth0-google-vercel"
  | "staffx-openship-bundle-import";
export type TemplateId = typeof BLANK_TEMPLATE_ID | NonBlankTemplateId;

export type TemplateNodeKind = "Host" | "Container" | "Process" | "Library";
export type TemplateEdgeType = "Runtime" | "Dataflow" | "Dependency";
export type TemplateDocKind = "Document" | "Skill";
export type TemplateRefType = "Document" | "Skill";

export interface TemplateNodeLayout {
  x: number;
  y: number;
}

export interface TemplateNode {
  key: string;
  name: string;
  kind: TemplateNodeKind;
  metadata: {
    ownership: "first_party" | "third_party";
    boundary: "internal" | "external";
  };
  parentKey?: string;
  layout?: TemplateNodeLayout;
}

export interface TemplateEdge {
  fromKey: string;
  toKey: string;
  type: TemplateEdgeType;
  protocol?: string;
}

export interface TemplateConcern {
  name: string;
  position: number;
  isBaseline: boolean;
  scope?: string | null;
}

export interface TemplateDocument {
  key: string;
  kind: TemplateDocKind;
  title: string;
  language: string;
  text: string;
}

export interface TemplateMatrixRef {
  nodeKey: string;
  concern: string;
  refType: TemplateRefType;
  documentKey: string;
}

export interface TemplateDefinition {
  id: NonBlankTemplateId;
  label: string;
  description: string;
  bundleImportPath?: string;
  nodes: TemplateNode[];
  edges: TemplateEdge[];
  concerns: TemplateConcern[];
  documents: TemplateDocument[];
  matrixRefs: TemplateMatrixRef[];
}

const templateRegistry: Record<NonBlankTemplateId, TemplateDefinition> = {
  "webserver-postgres-auth0-google-vercel": templateWebserverPostgresAuth0GoogleVercel,
  "staffx-openship-bundle-import": templateStaffxOpenShipBundleImport,
};

export function isKnownTemplateId(templateId: string): templateId is TemplateId {
  return templateId === BLANK_TEMPLATE_ID || templateId in templateRegistry;
}

export function getTemplateById(templateId: TemplateId): TemplateDefinition | null {
  if (templateId === BLANK_TEMPLATE_ID) return null;
  return templateRegistry[templateId];
}
