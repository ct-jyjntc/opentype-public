import { isAbsolute, join, normalize, parse } from 'node:path'

/** Honor the explicit Chromium profile switch, keeping all app data and logs together. */
export function resolveProfilePaths(options: {
  appData: string; defaultLogs: string; packaged: boolean; cliDirectory?: string; testDirectory?: string
}) {
  const custom = options.cliDirectory ?? (!options.packaged ? options.testDirectory : undefined)
  if (custom !== undefined && (!isAbsolute(custom) || normalize(custom) === parse(custom).root)) {
    throw new Error('user-data-dir must be an absolute non-root directory')
  }
  const userData = custom === undefined ? join(options.appData, 'dev.opentype.desktop') : normalize(custom)
  return { userData, logs: custom === undefined ? options.defaultLogs : join(userData, 'logs'), custom: custom !== undefined }
}
