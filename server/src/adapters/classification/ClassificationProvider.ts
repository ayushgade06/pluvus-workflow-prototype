import type { ClassificationRequest, ClassificationResponse } from "./types.js";

export interface ClassificationProvider {
  classify(req: ClassificationRequest): Promise<ClassificationResponse>;
}
