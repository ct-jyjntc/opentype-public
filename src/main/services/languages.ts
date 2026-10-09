// 语音识别支持的语言（112 种）。
//
// 依据界面语言键 language_selector__option__* 键。
// 注意与界面语言的区别：界面只本地化了 58 种，但语音能识别 112 种——
// 两个集合不同，因为识别能力在服务端，界面翻译在客户端。

/** 语言代码（BCP-47）→ 英文展示名。 */
export const SUPPORTED_LANGUAGES: Record<string, string> = {
  'af': 'Afrikaans',
  'am': 'Amharic',
  'ar-EG': 'Arabic (Egypt)',
  'ar-SA': 'Arabic (Saudi Arabia)',
  'as': 'Assamese',
  'az': 'Azerbaijani',
  'ba': 'Bashkir',
  'be': 'Belarusian',
  'bg': 'Bulgarian',
  'bn': 'Bengali',
  'bo': 'Tibetan',
  'br': 'Breton',
  'bs': 'Bosnian',
  'ca': 'Catalan',
  'cs': 'Czech',
  'cy': 'Welsh',
  'da': 'Danish',
  'de': 'German',
  'el': 'Greek',
  'en': 'English',
  'en-AU': 'English (AU)',
  'en-CA': 'English (CA)',
  'en-GB': 'English (UK)',
  'en-US': 'English (US)',
  'es': 'Spanish (Spain)',
  'es-ES': 'Spanish (Spain)',
  'es-MX': 'Spanish (Mexico)',
  'es-US': 'Spanish (United States)',
  'et': 'Estonian',
  'eu': 'Basque',
  'fa': 'Persian',
  'fi': 'Finnish',
  'fo': 'Faroese',
  'fr': 'French (France)',
  'fr-CA': 'French (Canada)',
  'fr-FR': 'French (France)',
  'gl': 'Galician',
  'gu': 'Gujarati',
  'ha': 'Hausa',
  'haw': 'Hawaiian',
  'he': 'Hebrew',
  'hi': 'Hindi',
  'hr': 'Croatian',
  'ht': 'Haitian Creole',
  'hu': 'Hungarian',
  'hy': 'Armenian',
  'id': 'Indonesian',
  'is': 'Icelandic',
  'it': 'Italian',
  'ja': 'Japanese',
  'jv': 'Javanese',
  'ka': 'Georgian',
  'kk': 'Kazakh',
  'km': 'Khmer',
  'kn': 'Kannada',
  'ko': 'Korean',
  'la': 'Latin',
  'lb': 'Luxembourgish',
  'ln': 'Lingala',
  'lo': 'Lao',
  'lt': 'Lithuanian',
  'lv': 'Latvian',
  'mg': 'Malagasy',
  'mi': 'Māori',
  'mk': 'Macedonian',
  'ml': 'Malayalam',
  'mn': 'Mongolian',
  'mr': 'Marathi',
  'ms': 'Malay',
  'mt': 'Maltese',
  'my': 'Burmese',
  'nb': 'Norwegian (Bokmål)',
  'ne': 'Nepali',
  'nl': 'Dutch',
  'nn': 'Norwegian Nynorsk',
  'oc': 'Occitan',
  'pa': 'Punjabi',
  'pl': 'Polish',
  'ps': 'Pashto',
  'pt-BR': 'Portuguese (Brazil)',
  'pt-PT': 'Portuguese (Portugal)',
  'ro': 'Romanian',
  'ru': 'Russian',
  'sa': 'Sanskrit',
  'sd': 'Sindhi',
  'si': 'Sinhala',
  'sk': 'Slovak',
  'sl': 'Slovenian',
  'sn': 'Shona',
  'so': 'Somali',
  'sq': 'Albanian',
  'sr': 'Serbian',
  'su': 'Sundanese',
  'sv': 'Swedish',
  'sw': 'Swahili',
  'ta': 'Tamil',
  'te': 'Telugu',
  'tg': 'Tajik',
  'th': 'Thai',
  'tk': 'Turkmen',
  'tl': 'Tagalog',
  'tr': 'Turkish',
  'tt': 'Tatar',
  'uk': 'Ukrainian',
  'ur': 'Urdu',
  'uz': 'Uzbek',
  'vi': 'Vietnamese',
  'yi': 'Yiddish',
  'yo': 'Yoruba',
  'zh-CN': 'Simplified Chinese (Mainland China)',
  'zh-HK': 'Traditional Chinese (Hong Kong)',
  'zh-TW': 'Traditional Chinese (Taiwan)',
}

/**
 * 有区域变体的语言。
 *
 * 依据 shortcuts__select_languages_modal__language__* 与文案
 * 「Only English, Chinese, Spanish, French, and Portuguese variants are available」。
 * 其余语言只提供单一形式，选变体没有意义。
 */
export const LANGUAGE_VARIANTS: Record<string, string[]> = {
  en: ['en', 'en-US', 'en-GB', 'en-AU', 'en-CA'],
  zh: ['zh-CN', 'zh-TW', 'zh-HK'],
  es: ['es', 'es-ES', 'es-MX', 'es-US'],
  fr: ['fr', 'fr-FR', 'fr-CA'],
  pt: ['pt-BR', 'pt-PT']
}

/** 语言总数。用于 UI 展示与断言。 */
export const SUPPORTED_LANGUAGE_COUNT = Object.keys(SUPPORTED_LANGUAGES).length

/** 判断是否为受支持的语言代码。 */
export function isSupportedLanguage(code: string): boolean {
  return code in SUPPORTED_LANGUAGES
}

/** 取展示名，未知代码原样返回。 */
export function languageDisplayName(code: string): string {
  return SUPPORTED_LANGUAGES[code] ?? code
}

/**
 * ASR 可用的基础语言码集合。
 *
 * 不能直接用 SUPPORTED_LANGUAGES 的键做校验：那张表是**界面语言**清单，
 * 中文只登记了 zh-CN / zh-TW / zh-HK 三个变体，没有裸 'zh'——
 * 而 whisper.cpp 要的恰恰是 'zh'。用界面表校验会把中文整个拒掉。
 *
 * 正确做法是取所有已知码的 ISO 639-1 部分，再并上 LANGUAGE_VARIANTS 的键。
 */
const ASR_BASE_CODES: ReadonlySet<string> = new Set([
  ...Object.keys(SUPPORTED_LANGUAGES).map((c) => c.split('-')[0].toLowerCase()),
  ...Object.keys(LANGUAGE_VARIANTS)
])

/**
 * 归一化成 ASR 能用的语言代码。
 *
 * whisper.cpp 只认 ISO 639-1 两字母码（zh / en / ja），
 * 而前端存的是 BCP-47 变体（zh-CN / en-US / pt-BR）。
 * 直接透传 'zh-CN' 会被 whisper 当成未知语言回退到默认值——
 * 实测表现为中文被按英文解码成同音乱码，所以必须在这里截断。
 */
export function toAsrLanguageCode(code: string): string | null {
  if (!code) return null
  const base = code.split('-')[0].toLowerCase()
  if (!base) return null
  // 只接受已知语言，避免把脏数据透传给 ASR
  return ASR_BASE_CODES.has(base) ? base : null
}

/**
 * 由用户勾选的识别语言列表推导 ASR 语言提示。
 *
 * 规则来自真实产品的行为：勾选多个**不同**语言意味着「我不确定会说哪个」，
 * 此时交给 ASR 自动检测；归一化后只剩一种语言才作为强提示。
 * （zh-CN 与 zh-TW 是同一语言的两个变体，归一后仍是单语言，故仍给强提示。）
 *
 * 自动检测对单语场景的准确率明显低于显式提示——这是实测结论：
 * whisper 的 language 参数缺省值是 en 而非 auto，不传就会按英文解码。
 */
export function resolveAsrLanguage(selected: readonly string[]): string {
  const unique = [...new Set(selected.map(toAsrLanguageCode).filter((x): x is string => Boolean(x)))]
  return unique.length === 1 ? unique[0] : 'auto'
}
