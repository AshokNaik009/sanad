export type Role = "biller" | "coder" | "doctor" | "finance" | "frontdesk" | "admin";
export type Regulator = "DHA" | "DOH";
export type CodeType = "ICD10" | "CPT" | "HCPCS" | "DRUG";

export interface Organization {
  id: string;
  name: string;
  emirate: string;
  regulator: Regulator;
  facilityLicence: string;
}

export interface User {
  id: string;
  orgId: string;
  name: string;
  role: Role;
  clinicianId?: string;
}

export interface Clinician {
  id: string;
  name: string;
  licence: string;
  specialty: Specialty;
}

export type Specialty = "GP" | "Physiotherapy" | "Dermatology" | "Orthopaedics" | "Lab";

export interface PlanBenefits {
  name: string;
  network: string;
  copayPercent: number;
  copayCapPerVisit: number;
  annualLimit: number;
  deductible: number;
}

export interface Payer {
  id: string;
  name: string;
  regulatorPayerId: string;
  /** Days from service date to first submission. */
  submissionWindowDays: number;
  /** Days from remittance to resubmission. */
  resubmissionWindowDays: number;
  /** Mean days from submission to payment, used for the forecast. */
  paymentLagDays: number;
  /** CPT/HCPCS codes (or prefixes ending in *) needing prior approval. */
  authRequired: string[];
  plans: PlanBenefits[];
  /** Contract price multiplier applied to the base tariff. */
  priceFactor: number;
}

export interface PriceListEntry {
  id: string;
  payerId: string;
  code: string;
  netPrice: number;
  effectiveFrom: string;
}

export interface Patient {
  id: string;
  name: string;
  dob: string;
  gender: "M" | "F";
  emiratesIdEnc: string;
  emiratesIdMasked: string;
  memberId: string;
  payerId: string;
  plan: string;
  coverageStart: string;
  coverageEnd: string;
  network: string;
}

export interface EvidenceSpan {
  start: number;
  end: number;
  text: string;
}

export type SuggestionDecision = "pending" | "accepted" | "edited" | "rejected";

export interface CodeSuggestion {
  id: string;
  code: string;
  codeType: CodeType;
  description: string;
  confidence: number;
  evidence: EvidenceSpan[];
  role: "principal" | "secondary" | "procedure";
  decision: SuggestionDecision;
  editedCode?: string;
}

export interface DocumentationQuery {
  id: string;
  encounterId: string;
  clinicianId: string;
  question: string;
  reason: string;
  status: "open" | "answered";
  answer?: string;
  createdAt: string;
  answeredAt?: string;
}

export interface Encounter {
  id: string;
  externalId?: string;
  patientId: string;
  clinicianId: string;
  payerId: string;
  date: string;
  type: "outpatient" | "daycase" | "emergency";
  specialty: Specialty;
  note: string;
  source: "synthetic_emr" | "upload" | "fhir" | "api";
  status: "to_code" | "coded" | "claimed";
  priorAuthNumber?: string;
  suggestions?: CodeSuggestion[];
  gaps?: { id: string; question: string; reason: string }[];
  codedAt?: string;
  claimId?: string;
  gold?: { principal: string; procedures: string[] };
}

export type ClaimStatus =
  | "draft"
  | "scrubbed"
  | "submitted"
  | "acknowledged"
  | "rejected"
  | "paid"
  | "partially_paid"
  | "denied"
  | "resubmitted"
  | "written_off";

export interface Activity {
  id: string;
  codeType: CodeType;
  code: string;
  description: string;
  quantity: number;
  gross: number;
  patientShare: number;
  net: number;
  priorAuthNumber?: string;
  clinicianLicence?: string;
  paid?: number;
  denialCode?: string;
}

export interface Diagnosis {
  code: string;
  type: "principal" | "secondary";
  description: string;
}

export interface ScrubIssue {
  id: string;
  rule: string;
  family: string;
  severity: "blocking" | "warning";
  field: string;
  message: string;
  fix: string;
  autoFix?: { kind: string; activityId?: string; value?: unknown };
}

export interface TimelineEntry {
  status: ClaimStatus | string;
  at: string;
  by?: string;
  note?: string;
}

export interface Claim {
  id: string;
  encounterId?: string;
  patientId: string;
  payerId: string;
  payerName: string;
  clinicianId: string;
  clinicianName: string;
  clinicianLicence?: string;
  specialty: Specialty;
  encounterType?: string;
  serviceDate: string;
  status: ClaimStatus;
  diagnoses: Diagnosis[];
  activities: Activity[];
  gross: number;
  patientShare: number;
  net: number;
  paidAmount?: number;
  cleanClaimScore?: number;
  denialRisk?: number;
  issues?: ScrubIssue[];
  submissionId?: string;
  submittedAt?: string;
  approvedBy?: string;
  approvedAt?: string;
  paidAt?: string;
  firstPass?: boolean;
  historical?: boolean;
  resubmissionCount?: number;
  timeline: TimelineEntry[];
  seed?: { errors?: string[]; denial?: string; underpay?: boolean };
}

export type DenialCategory =
  | "auth"
  | "eligibility"
  | "coding"
  | "medical_necessity"
  | "pricing"
  | "duplicate"
  | "timeliness"
  | "documentation";

export interface Citation {
  quote: string;
  start: number;
  end: number;
}

export interface ResubmissionDraft {
  summary: string;
  fieldFixes: { field: string; activityId?: string; from?: string; to: string; reason: string }[];
  justification: { sentence: string; citations: Citation[] }[];
  attachments: string[];
  blockedSentences: string[];
  type: "correction" | "internal complaint";
  generatedAt: string;
  ms: number;
  suggestionId: string;
}

export interface Denial {
  id: string;
  claimId: string;
  activityId: string;
  activityCode: string;
  payerId: string;
  payerName: string;
  clinicianName: string;
  specialty: Specialty;
  code: string;
  payerComment?: string;
  plainReason: string;
  category: DenialCategory;
  classifiedBy: "lookup" | "ai";
  amount: number;
  recoveryProbability: number;
  recoveryBand: "High" | "Medium" | "Low";
  priorityScore: number;
  deniedAt: string;
  deadline: string;
  status: "open" | "resubmitted" | "written_off" | "recovered" | "lost";
  assignedTo?: string;
  draft?: ResubmissionDraft;
  writeOffReason?: string;
  resubmittedAt?: string;
  recoveredAmount?: number;
  historical?: boolean;
}

export interface RemittanceLine {
  id: string;
  remittanceId: string;
  claimId: string;
  activityId: string;
  activityCode: string;
  payerId: string;
  payerName: string;
  expected: number;
  paid: number;
  variance: number;
  denialCode?: string;
  paymentReference: string;
  settledAt: string;
  status: "paid" | "underpaid" | "denied" | "unmatched";
  matched: boolean;
}

export interface Remittance {
  id: string;
  payerId: string;
  receivedAt: string;
  xml: string;
  lineCount: number;
  matched: number;
}

export interface Submission {
  id: string;
  kind: "claim" | "resubmission" | "prior_request";
  claimIds: string[];
  xml: string;
  approverId: string;
  approvedAt: string;
  gatewayResponse?: unknown;
  status: "sent" | "acknowledged" | "rejected";
}

export interface PriorAuth {
  id: string;
  encounterId?: string;
  patientId: string;
  payerId: string;
  services: { code: string; description: string }[];
  diagnosis: string;
  justification: string;
  status: "draft" | "pending" | "approved" | "rejected" | "info_requested";
  approvalNumber?: string;
  validUntil?: string;
  gatewayRef?: string;
  approvedBy?: string;
  createdAt: string;
}

export interface AiSuggestionLog {
  id: string;
  target: "encounter" | "claim" | "denial" | "prior_auth" | "copilot";
  targetId: string;
  task: "coding" | "gap" | "classification" | "resubmission" | "prior_auth" | "copilot";
  payload: unknown;
  confidence?: number;
  outcome: "pending" | "accepted" | "edited" | "rejected";
  engine: "sample" | "model";
  userId?: string;
  createdAt: string;
  decidedAt?: string;
}

export interface AuditEvent {
  id: string;
  seq: number;
  actor: string;
  role: Role | "system";
  action: string;
  entity: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  at: string;
  prevHash: string;
  hash: string;
}

export interface Notification {
  id: string;
  kind: "deadline" | "remittance" | "prior_auth" | "query";
  message: string;
  entityId: string;
  createdAt: string;
  read: boolean;
}

export interface ShareLink {
  id: string;
  claimId?: string;
  estimate?: unknown;
  expiresAt: string;
  createdAt: string;
}
