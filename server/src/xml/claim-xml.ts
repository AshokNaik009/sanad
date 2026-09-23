// DHA-style XML transactions: Claim.Submission (with optional Resubmission), Prior.Request,
// and Remittance.Advice parsing. Validation uses the pinned structural schema in /schemas.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";
import { ACTIVITY_TYPE_CODE } from "../data/codeset.ts";
import type { Claim } from "../domain/types.ts";
import { dhaDate } from "../util.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = join(here, "../../../schemas/claim-submission.dha-v1.json");

type Cardinality = [number, number];
interface ElementSpec {
  children?: Record<string, Cardinality>;
  type?: "string" | "decimal" | "integer" | "dhaDate" | "enum";
  pattern?: string;
  values?: string[];
  min?: number;
  minLength?: number;
  maxLength?: number;
}
interface Schema {
  version: string;
  root: string;
  elements: Record<string, ElementSpec>;
}

let schemaCache: Schema | undefined;
export function claimSchema(): Schema {
  schemaCache ??= JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as Schema;
  return schemaCache;
}

const esc = (value: string | number) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const el = (name: string, value: string | number | undefined, indent: string) =>
  value === undefined || value === "" ? "" : `${indent}<${name}>${esc(value)}</${name}>\n`;

const ENCOUNTER_TYPE: Record<string, string> = { outpatient: "1", daycase: "3", emergency: "4" };

export interface ClaimXmlInput {
  claim: Claim;
  memberId: string;
  emiratesId: string;
  payerRegulatorId: string;
  facilityLicence: string;
  resubmission?: { type: string; comment: string; attachment?: string };
}

export function buildClaimSubmission(
  senderId: string,
  receiverId: string,
  items: ClaimXmlInput[],
  now = new Date(),
): string {
  const body = items
    .map(({ claim, memberId, emiratesId, payerRegulatorId, facilityLicence, resubmission }) => {
      const i2 = "    ";
      const i3 = "      ";
      const start = dhaDate(`${claim.serviceDate}T09:00:00Z`);
      let xml = "  <Claim>\n";
      xml += el("ID", claim.id, i2);
      xml += el("MemberID", memberId, i2);
      xml += el("PayerID", payerRegulatorId, i2);
      xml += el("ProviderID", facilityLicence, i2);
      xml += el("EmiratesIDNumber", emiratesId, i2);
      xml += el("Gross", claim.gross.toFixed(2), i2);
      xml += el("PatientShare", claim.patientShare.toFixed(2), i2);
      xml += el("Net", claim.net.toFixed(2), i2);
      xml += `${i2}<Encounter>\n`;
      xml += el("FacilityID", facilityLicence, i3);
      xml += el("Type", claim.encounterType ? ENCOUNTER_TYPE[claim.encounterType] ?? "" : "", i3);
      xml += el("PatientID", claim.patientId, i3);
      xml += el("Start", start, i3);
      xml += `${i2}</Encounter>\n`;
      for (const d of claim.diagnoses) {
        xml += `${i2}<Diagnosis>\n`;
        xml += el("Type", d.type === "principal" ? "Principal" : "Secondary", i3);
        xml += el("Code", d.code, i3);
        xml += `${i2}</Diagnosis>\n`;
      }
      for (const a of claim.activities) {
        xml += `${i2}<Activity>\n`;
        xml += el("ID", a.id, i3);
        xml += el("Start", start, i3);
        xml += el("Type", a.codeType === "ICD10" ? "" : ACTIVITY_TYPE_CODE[a.codeType], i3);
        xml += el("Code", a.code, i3);
        xml += el("Quantity", a.quantity, i3);
        xml += el("Net", a.net.toFixed(2), i3);
        xml += el("Clinician", a.clinicianLicence ?? claim.clinicianLicence, i3);
        xml += el("PriorAuthorizationID", a.priorAuthNumber, i3);
        xml += `${i2}</Activity>\n`;
      }
      if (resubmission) {
        xml += `${i2}<Resubmission>\n`;
        xml += el("Type", resubmission.type, i3);
        xml += el("Comment", resubmission.comment, i3);
        xml += el("Attachment", resubmission.attachment, i3);
        xml += `${i2}</Resubmission>\n`;
      }
      return `${xml}  </Claim>\n`;
    })
    .join("");
  return `<?xml version="1.0" encoding="utf-8"?>
<Claim.Submission xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Header>
    <SenderID>${esc(senderId)}</SenderID>
    <ReceiverID>${esc(receiverId)}</ReceiverID>
    <TransactionDate>${dhaDate(now)}</TransactionDate>
    <RecordCount>${items.length}</RecordCount>
    <DispositionFlag>TEST DATA</DispositionFlag>
  </Header>
${body}</Claim.Submission>
`;
}

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => ["Claim", "Diagnosis", "Activity"].includes(name),
});

export function parseXml(xml: string): Record<string, unknown> {
  return parser.parse(xml) as Record<string, unknown>;
}

export interface SchemaError {
  path: string;
  message: string;
}

/** Validate an XML document against the pinned structural schema. Returns [] when valid. */
export function validateClaimXml(xml: string): SchemaError[] {
  const schema = claimSchema();
  const errors: SchemaError[] = [];
  let doc: Record<string, unknown>;
  try {
    doc = parseXml(xml);
  } catch (error) {
    return [{ path: "/", message: `Not well-formed XML: ${(error as Error).message}` }];
  }
  const root = doc[schema.root];
  if (!root || typeof root !== "object") return [{ path: "/", message: `Root element must be ${schema.root}` }];
  const specFor = (parent: string, name: string) =>
    schema.elements[`${parent}.${name}`] ?? schema.elements[name];
  const visit = (name: string, parent: string, node: unknown, path: string) => {
    const spec = specFor(parent, name);
    if (!spec) {
      errors.push({ path, message: `Unexpected element ${name}` });
      return;
    }
    if (spec.children) {
      if (typeof node !== "object" || node === null) {
        errors.push({ path, message: `${name} must contain child elements` });
        return;
      }
      const obj = node as Record<string, unknown>;
      for (const key of Object.keys(obj))
        if (!(key in spec.children)) errors.push({ path: `${path}/${key}`, message: `Unexpected element ${key} in ${name}` });
      for (const [child, [min, max]] of Object.entries(spec.children)) {
        const raw = obj[child];
        const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
        if (list.length < min) errors.push({ path: `${path}/${child}`, message: `${child} is required in ${name}` });
        if (list.length > max) errors.push({ path: `${path}/${child}`, message: `${child} may occur at most ${max} times in ${name}` });
        list.forEach((item, i) => visit(child, name, item, `${path}/${child}${list.length > 1 ? `[${i + 1}]` : ""}`));
      }
      return;
    }
    const value = typeof node === "string" || typeof node === "number" ? String(node) : "";
    if (!value) {
      errors.push({ path, message: `${name} must not be empty` });
      return;
    }
    switch (spec.type) {
      case "decimal":
      case "integer": {
        const ok = spec.type === "integer" ? /^-?\d+$/.test(value) : /^-?\d+(\.\d+)?$/.test(value);
        if (!ok) errors.push({ path, message: `${name} must be a${spec.type === "integer" ? "n integer" : " decimal"}` });
        else if (spec.min !== undefined && Number(value) < spec.min) errors.push({ path, message: `${name} must be at least ${spec.min}` });
        break;
      }
      case "dhaDate":
        if (!/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/.test(value)) errors.push({ path, message: `${name} must be dd/MM/yyyy HH:mm` });
        break;
      case "enum":
        if (!spec.values?.includes(value)) errors.push({ path, message: `${name} must be one of ${spec.values?.join(", ")}` });
        break;
      default:
        if (spec.pattern && !new RegExp(spec.pattern).test(value)) errors.push({ path, message: `${name} "${value}" does not match ${spec.pattern}` });
        if (spec.minLength !== undefined && value.length < spec.minLength) errors.push({ path, message: `${name} must be at least ${spec.minLength} characters` });
        if (spec.maxLength !== undefined && value.length > spec.maxLength) errors.push({ path, message: `${name} must be at most ${spec.maxLength} characters` });
    }
  };
  visit(schema.root, "", root, `/${schema.root}`);
  return errors;
}

export interface PriorRequestInput {
  id: string;
  memberId: string;
  emiratesId: string;
  payerRegulatorId: string;
  facilityLicence: string;
  clinicianLicence: string;
  diagnosis: string;
  services: { code: string; codeType: string }[];
  justification: string;
}

export function buildPriorRequest(input: PriorRequestInput, now = new Date()): string {
  const acts = input.services
    .map(
      (s, i) =>
        `    <Activity>\n      <ID>${i + 1}</ID>\n      <Type>${ACTIVITY_TYPE_CODE[s.codeType as "CPT"] ?? 3}</Type>\n      <Code>${esc(s.code)}</Code>\n      <Quantity>1</Quantity>\n      <Clinician>${esc(input.clinicianLicence)}</Clinician>\n    </Activity>\n`,
    )
    .join("");
  return `<?xml version="1.0" encoding="utf-8"?>
<Prior.Request>
  <Header>
    <SenderID>${esc(input.facilityLicence)}</SenderID>
    <ReceiverID>${esc(input.payerRegulatorId)}</ReceiverID>
    <TransactionDate>${dhaDate(now)}</TransactionDate>
    <RecordCount>1</RecordCount>
    <DispositionFlag>TEST DATA</DispositionFlag>
  </Header>
  <Authorization>
    <Type>Authorization</Type>
    <ID>${esc(input.id)}</ID>
    <MemberID>${esc(input.memberId)}</MemberID>
    <PayerID>${esc(input.payerRegulatorId)}</PayerID>
    <EmiratesIDNumber>${esc(input.emiratesId)}</EmiratesIDNumber>
    <Diagnosis>
      <Type>Principal</Type>
      <Code>${esc(input.diagnosis)}</Code>
    </Diagnosis>
${acts}    <Observation>
      <Type>Text</Type>
      <Code>Justification</Code>
      <Value>${esc(input.justification)}</Value>
    </Observation>
  </Authorization>
</Prior.Request>
`;
}

export interface ParsedRemittanceActivity {
  id: string;
  code: string;
  net: number;
  paymentAmount: number;
  denialCode?: string;
}
export interface ParsedRemittanceClaim {
  id: string;
  idPayer?: string;
  paymentReference: string;
  dateSettlement: string;
  comments?: string;
  activities: ParsedRemittanceActivity[];
}

export function parseRemittanceAdvice(xml: string): { senderId: string; claims: ParsedRemittanceClaim[] } {
  const doc = parseXml(xml)["Remittance.Advice"] as Record<string, any> | undefined;
  if (!doc) throw new Error("Not a Remittance.Advice document");
  const claims = (doc.Claim ?? []) as Record<string, any>[];
  return {
    senderId: String(doc.Header?.SenderID ?? ""),
    claims: claims.map((c) => ({
      id: String(c.ID),
      idPayer: c.IDPayer ? String(c.IDPayer) : undefined,
      paymentReference: String(c.PaymentReference ?? ""),
      dateSettlement: String(c.DateSettlement ?? ""),
      comments: c.Comments ? String(c.Comments) : undefined,
      activities: ((c.Activity ?? []) as Record<string, any>[]).map((a) => ({
        id: String(a.ID),
        code: String(a.Code),
        net: Number(a.Net),
        paymentAmount: Number(a.PaymentAmount),
        denialCode: a.DenialCode ? String(a.DenialCode) : undefined,
      })),
    })),
  };
}

export function buildRemittanceAdvice(
  senderId: string,
  receiverId: string,
  claims: ParsedRemittanceClaim[],
  now = new Date(),
): string {
  const body = claims
    .map((c) => {
      const acts = c.activities
        .map(
          (a) =>
            `    <Activity>\n      <ID>${esc(a.id)}</ID>\n      <Code>${esc(a.code)}</Code>\n      <Net>${a.net.toFixed(2)}</Net>\n      <PaymentAmount>${a.paymentAmount.toFixed(2)}</PaymentAmount>\n${a.denialCode ? `      <DenialCode>${esc(a.denialCode)}</DenialCode>\n` : ""}    </Activity>\n`,
        )
        .join("");
      return `  <Claim>\n    <ID>${esc(c.id)}</ID>\n    <IDPayer>${esc(c.idPayer ?? "")}</IDPayer>\n    <PaymentReference>${esc(c.paymentReference)}</PaymentReference>\n    <DateSettlement>${esc(c.dateSettlement)}</DateSettlement>\n${c.comments ? `    <Comments>${esc(c.comments)}</Comments>\n` : ""}${acts}  </Claim>\n`;
    })
    .join("");
  return `<?xml version="1.0" encoding="utf-8"?>
<Remittance.Advice>
  <Header>
    <SenderID>${esc(senderId)}</SenderID>
    <ReceiverID>${esc(receiverId)}</ReceiverID>
    <TransactionDate>${dhaDate(now)}</TransactionDate>
    <RecordCount>${claims.length}</RecordCount>
    <DispositionFlag>TEST DATA</DispositionFlag>
  </Header>
${body}</Remittance.Advice>
`;
}
