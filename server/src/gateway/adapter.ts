// Gateway adapter layer (PRD section 8). The same interface serves the mock gateway and, post-MVP,
// real eClaimLink/Shafafiya/NPHIES adapters, so the demo code path is the production code path.
import { AppError } from "../util.ts";

export interface SubmitResult {
  status: "acknowledged" | "rejected";
  transactionId?: string;
  errors?: { path: string; message: string }[];
  claims?: { id: string; idPayer: string }[];
}

export interface PriorAuthStatus {
  ref: string;
  status: "pending" | "approved" | "rejected" | "info_requested";
  approvalNumber?: string;
  validUntil?: string;
  comment?: string;
}

export interface EligibilityResult {
  eligible: boolean;
  payerId?: string;
  memberId?: string;
  plan?: string;
  network?: string;
  coverageStart?: string;
  coverageEnd?: string;
  copayPercent?: number;
  copayCapPerVisit?: number;
  reason?: string;
}

export interface GatewayAdapter {
  readonly name: string;
  submitClaims(senderId: string, xml: string): Promise<SubmitResult>;
  fetchRemittances(senderId: string): Promise<{ id: string; xml: string }[]>;
  submitPriorRequest(senderId: string, xml: string): Promise<{ ref: string; status: string }>;
  fetchPriorAuth(senderId: string, ref: string): Promise<PriorAuthStatus>;
  checkEligibility(query: {
    emiratesId?: string;
    memberId?: string;
    payerId?: string;
    date: string;
  }): Promise<EligibilityResult>;
}

/** HTTP adapter speaking the transaction-level API exposed by the gateway (mock or real proxy). */
export class HttpGatewayAdapter implements GatewayAdapter {
  readonly name = "http";
  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new AppError(`Gateway unreachable: ${(error as Error).message}`, 503);
    }
    const body = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) throw new AppError(body.error ?? `Gateway error ${response.status}`, 502);
    return body;
  }

  submitClaims(senderId: string, xml: string) {
    return this.call<SubmitResult>("/claims", {
      method: "POST",
      headers: { "Content-Type": "application/xml", "X-Sender-ID": senderId },
      body: xml,
    });
  }
  async fetchRemittances(senderId: string) {
    const out = await this.call<{ remittances: { id: string; xml: string }[] }>(
      `/remittances?sender=${encodeURIComponent(senderId)}`,
    );
    return out.remittances;
  }
  submitPriorRequest(senderId: string, xml: string) {
    return this.call<{ ref: string; status: string }>("/prior-requests", {
      method: "POST",
      headers: { "Content-Type": "application/xml", "X-Sender-ID": senderId },
      body: xml,
    });
  }
  fetchPriorAuth(senderId: string, ref: string) {
    return this.call<PriorAuthStatus>(
      `/prior-requests/${encodeURIComponent(ref)}?sender=${encodeURIComponent(senderId)}`,
    );
  }
  checkEligibility(query: { emiratesId?: string; memberId?: string; payerId?: string; date: string }) {
    const params = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v) as [string, string][],
    );
    return this.call<EligibilityResult>(`/eligibility?${params}`);
  }
}
