/** Intermediate text is display-only. It must never be used as a delivery result. */
export interface ProcessingProgress {
  stage: 'transcribing' | 'refining'
  preview?: string
}
