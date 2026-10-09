export interface CorrectionCandidate {
  id: string
  historyId: string
  original: string
  replacement: string
  createdAt: string
  appName: string
  sourceKind: 'history_edit' | 'input_edit'
}
export interface CorrectionList { items: CorrectionCandidate[]; total: number; hasMore: boolean }
export interface HistoryEditResult { candidates: number }
export interface CorrectionAcceptance { added: boolean; dictionaryId: string }
