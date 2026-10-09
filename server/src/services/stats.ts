// 首页/分享页的统计计算：全部从 history 表真实数据推导。
//
// 形状契约（渲染层反查）：
//   usage_stats → data.voice_transcription.{total_words,mins_saved,avg_wpm,total_audio_seconds}
//   insights    → data.summary.{active_days,current_streak,longest_streak}
//                 data.heatmap.{days:[{date:'YYYY-MM-DD',level:0-4}],has_more_before}
// 分享页直接读 summary.active_days，缺了 summary 会抛 TypeError 白屏。

import { getDb } from '../db/index.ts'

/** 中英混排字数：CJK 逐字计，拉丁按词计。 */
function countWords(text: string): number {
  if (!text) return 0
  const cjk = (text.match(/[一-鿿㐀-䶿]/g) ?? []).length
  const latin = (text.replace(/[一-鿿㐀-䶿]/g, ' ').match(/[A-Za-z0-9']+/g) ?? []).length
  return cjk + latin
}

interface HistoryStatRow { refined_text: string | null; duration: number | null; created_at: string }

function userRows(userId: string): HistoryStatRow[] {
  return getDb()
    .prepare("SELECT refined_text, duration, created_at FROM history WHERE user_id = ? AND status = 'completed'")
    .all(userId) as unknown as HistoryStatRow[]
}

export function getUsageStats(userId: string) {
  const rows = userRows(userId)
  let totalWords = 0
  let totalAudioSeconds = 0
  for (const r of rows) {
    totalWords += countWords(r.refined_text ?? '')
    totalAudioSeconds += Number(r.duration ?? 0)
  }
  // 节省时间：按 40 字/分钟的打字速度折算
  const minsSaved = Math.round((totalWords / 40) * 10) / 10
  const avgWpm = totalAudioSeconds > 0 ? Math.round(totalWords / (totalAudioSeconds / 60)) : 0
  return {
    voice_transcription: {
      total_words: totalWords,
      mins_saved: minsSaved,
      avg_wpm: avgWpm,
      total_audio_seconds: Math.round(totalAudioSeconds)
    }
  }
}

/** 本地日期键 YYYY-MM-DD（created_at 是 ISO 字符串，转本地时区再取日）。 */
function dayKey(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function getInsights(userId: string) {
  const rows = userRows(userId)
  const perDay = new Map<string, number>()
  for (const r of rows) {
    const k = dayKey(r.created_at)
    perDay.set(k, (perDay.get(k) ?? 0) + 1)
  }

  // 热力图：按当日条数分级（0/1-3/4-8/9-15/16+）
  const levelOf = (n: number) => (n === 0 ? 0 : n <= 3 ? 1 : n <= 8 ? 2 : n <= 15 ? 3 : 4)
  const days = [...perDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, n]) => ({ date, level: levelOf(n) }))

  // 连续天数：从今天或昨天往回数
  const activeDays = [...perDay.keys()].sort()
  const activeSet = new Set(activeDays)
  const at = (offsetFromToday: number) => {
    const d = new Date()
    d.setDate(d.getDate() - offsetFromToday)
    return dayKey(d.toISOString())
  }
  // 注意：dayKey(at(n)) 依赖本地时区一致性，at() 先转 ISO 再转回来是恒等变换
  let currentStreak = 0
  let cursor = activeSet.has(at(0)) ? 0 : (activeSet.has(at(1)) ? 1 : -1)
  while (cursor >= 0 && activeSet.has(at(cursor))) { currentStreak++; cursor++ }

  let longestStreak = 0
  let run = 0
  let prev = ''
  for (const day of activeDays) {
    if (prev) {
      const prevDate = new Date(prev)
      prevDate.setDate(prevDate.getDate() + 1)
      run = dayKey(prevDate.toISOString()) === day ? run + 1 : 1
    } else {
      run = 1
    }
    if (run > longestStreak) longestStreak = run
    prev = day
  }

  return {
    summary: {
      active_days: activeDays.length,
      current_streak: currentStreak,
      longest_streak: longestStreak
    },
    heatmap: { days, has_more_before: false }
  }
}
