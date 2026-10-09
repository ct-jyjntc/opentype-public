// 音频采集的共享常量。
//
// 单独成文件的原因：worklet 处理器（音频线程）与采集管理器（主线程）
// 都需要 PROCESSOR_NAME，但如果从 worklet.ts 导出，整个 worklet 模块
// 会被打进主渲染包——而 AudioWorkletProcessor 在主线程不存在，
// 一执行就抛 ReferenceError，导致整个 React 应用白屏。

/** 处理器注册名。主线程创建 AudioWorkletNode 时用，worklet 注册时也用。 */
export const PROCESSOR_NAME = 'opentype-audio-capture'

/** 每条消息携带的样本数。16kHz 下约 64ms。 */
export const SAMPLES_PER_MESSAGE = 1024
