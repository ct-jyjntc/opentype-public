import { createRoot } from 'react-dom/client'
import { SpeechSettings } from './speech-settings'
import { useSyncedTheme } from './theme'
import './app.css'
function SpeechSettingsWindow() {
  useSyncedTheme()
  return <SpeechSettings />
}
createRoot(document.getElementById('root')!).render(<SpeechSettingsWindow />)
