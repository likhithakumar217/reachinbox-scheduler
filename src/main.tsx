
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import LocalApp from './LocalApp.tsx'

const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)
const RootApp = isLocal && import.meta.env.VITE_PUBLIC_DEMO !== 'true' ? LocalApp : App

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootApp />
  </StrictMode>,
)
