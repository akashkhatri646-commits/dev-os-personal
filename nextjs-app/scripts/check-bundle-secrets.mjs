// Fails when a built browser bundle contains a secret: the name of a server-only variable, or the
// value of one set in the environment or .env.local. Run after `npm run build` (npm run check:bundle).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const bundleDir = path.join(root, process.env.NEXT_DIST_DIR || '.next', 'static')

const SECRET_NAMES = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'OPENAI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'WORKER_SECRET',
  'SOURCE_KEY_PEPPER',
  'PATIENT_ID_HMAC_KEY',
  'PATIENT_ID_ENC_KEY',
  'ALERT_WEBHOOK_URL',
]

function envFileValues() {
  const file = path.join(root, '.env.local')
  if (!existsSync(file)) return {}
  const values = {}
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, '').split('#')[0].trim()
  }
  return values
}

function files(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry)
    return statSync(full).isDirectory() ? files(full) : /\.(js|css|map)$/.test(entry) ? [full] : []
  })
}

if (!existsSync(bundleDir)) {
  console.error('No build found. Run "npm run build" first.')
  process.exit(2)
}

const fromFile = envFileValues()
const secretValues = SECRET_NAMES.map((name) => ({ name, value: process.env[name] || fromFile[name] })).filter((entry) => entry.value && entry.value.length >= 12)

const problems = []
for (const file of files(bundleDir)) {
  const text = readFileSync(file, 'utf8')
  for (const name of SECRET_NAMES) if (text.includes(name)) problems.push(`${path.relative(root, file)} contains the name ${name}`)
  for (const { name, value } of secretValues) if (text.includes(value)) problems.push(`${path.relative(root, file)} contains the VALUE of ${name}`)
}

if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log(`Checked ${files(bundleDir).length} bundle files against ${SECRET_NAMES.length} secret names and ${secretValues.length} secret values: nothing found.`)
