// 画面の枠と経路（docs/implementation.md 5.5・5.8 (3)）
import './tokens.css'
import './app.css'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { connectEvents } from './load.ts'
import { startNotify } from './notify.ts'

connectEvents()
startNotify()
const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
