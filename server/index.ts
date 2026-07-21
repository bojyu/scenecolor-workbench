import express from 'express'
import cors from 'cors'
import { config } from 'dotenv'
import { existsSync } from 'fs'
import { join } from 'path'
import { apiRouter } from './routes/api.js'

config()
const app = express()
const PORT = 3001

const allowedOrigins = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
])

app.disable('x-powered-by')
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) callback(null, true)
    else callback(new Error('不允许的请求来源'))
  },
}))
app.use(express.json({ limit: '50mb' }))

app.use('/api', apiRouter)

const distDir = join(process.cwd(), 'dist')
if (existsSync(distDir)) {
  app.use(express.static(distDir, { index: false, dotfiles: 'ignore' }))
  app.get('*', (_req, res) => res.sendFile(join(distDir, 'index.html')))
}

app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error.message === '不允许的请求来源') {
    res.status(403).json({ success: false, error: error.message })
    return
  }
  res.status(500).json({ success: false, error: '服务器内部错误' })
})

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Server running on http://localhost:${PORT}`)
})
