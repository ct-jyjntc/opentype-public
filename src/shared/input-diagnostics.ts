export interface InputDiagnostics {
  summary: { reason?: string; stage?: string }
  events: Record<string, unknown>[]
}
