import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { initThemeFromStorage } from './lib/theme'
import './styles.css'

// 首帧前套用持久化主题，避免启动白闪
initThemeFromStorage()

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
