// 词典 CSV 解析：file:pick-and-parse-dictionary-csv 的纯逻辑部分。
//
// 渲染层契约（从构建产物实测）：
//   成功 { success:true, fileName, words } —— words 是字符串数组，
//        渲染层直接 words.join('\n') 发给云端 /user/dictionary/bulk-import/preview，
//        所以每个元素必须是 CSV 的一整行（词 或 词,释义），不能拆列。
//   失败 { success:false, fileName, reason } —— reason 是 i18n 分支键：
//        'canceled' | 'fileTooLarge' | 'fileType' | 'empty' | 'tooManyWords' | 'readFailed'
//        落在枚举外会显示通用错误文案。

/** 文件大小上限。超出报 fileTooLarge。 */
export const DICTIONARY_CSV_MAX_BYTES = 5 * 1024 * 1024
/** 词条数上限。超出报 tooManyWords（渲染层有对应文案）。 */
export const DICTIONARY_CSV_MAX_WORDS = 5000

export type DictionaryCsvParseResult =
  | { success: true; fileName: string; words: string[] }
  | { success: false; fileName: string; reason: string }

/**
 * 把 CSV 文本解析为行数组。
 *
 * 只去 BOM、统一换行、去掉空行；不剥表头、不拆列——
 * 云端 preview 接口会逐行校验并在结果里给出每行的 status，
 * 表头行会以「非法行」的形式出现在预览里，由用户决定去留。
 */
export function parseDictionaryCsv(text: string, fileName: string): DictionaryCsvParseResult {
  const words = text
    .replace(/^\uFEFF/, '')
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  if (words.length === 0) return { success: false, fileName, reason: 'empty' }
  if (words.length > DICTIONARY_CSV_MAX_WORDS) {
    return { success: false, fileName, reason: 'tooManyWords' }
  }
  return { success: true, fileName, words }
}

/** Local CSV import accepts one or two columns, quoted commas and escaped quotes. */
export function parseLocalDictionaryRows(text: string): Array<{term:string;hint:string}> {
  const rows:string[][]=[];let fields:string[]=[],field='',quoted=false
  for(let i=0;i<text.length;i++){
    const c=text[i]
    if(c==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++}else quoted=!quoted}
    else if(c===','&&!quoted){fields.push(field);field=''}
    else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;fields.push(field);if(fields.some(v=>v.trim()))rows.push(fields);fields=[];field=''}
    else field+=c
  }
  if(quoted)throw new Error('invalid_csv')
  fields.push(field);if(fields.some(v=>v.trim()))rows.push(fields)
  if(rows[0]&&/^(term|word|词汇|词条)$/i.test(rows[0][0].replace(/^\uFEFF/,'').trim()))rows.shift()
  return rows.map(row=>{const term=row[0].replace(/^\uFEFF/,'').trim(),hint=(row[1]??'').trim();if(row.length>2||!term||term.length>100||hint.length>100)throw new Error('invalid_csv');return {term,hint}})
}
