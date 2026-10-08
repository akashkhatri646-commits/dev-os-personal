// One command for local development: the web server and the background worker together.   npm run dev:all
import { spawn } from 'node:child_process'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const node = process.execPath
const children = [
  spawn(node, [path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next'), 'dev'], { cwd: root, stdio: 'inherit' }),
  // Give the server a moment to start; the worker retries quietly until it answers.
  spawn(node, [path.join(root, 'scripts', 'dev-worker.mjs')], { cwd: root, stdio: 'inherit' }),
]
const stop = () => children.forEach((child) => child.kill())
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
for (const child of children) child.on('exit', (code) => { stop(); process.exit(code ?? 0) })
