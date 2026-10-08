// Production build into its own folder, so it cannot corrupt a running `npm run dev`.   npm run build:check
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const env = { ...process.env, NEXT_DIST_DIR: '.next-check' }
const run = (args) => spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' }).status ?? 1
const built = run([path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build'])
if (built !== 0) process.exit(built)
process.exit(run([path.join(root, 'scripts', 'check-bundle-secrets.mjs')]))
