import type { NegotiationRequest, NegotiationResponse, DraftRequest, DraftResponse } from "./types.js";

export interface NegotiationProvider {
  negotiate(req: NegotiationRequest): Promise<NegotiationResponse>;
  draft(req: DraftRequest): Promise<DraftResponse>;
}
