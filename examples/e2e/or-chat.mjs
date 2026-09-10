// A minimal "agent" for command steps: one OpenRouter chat completion.
//   node or-chat.mjs --model <id> --prompt "<text>" [--context-path steps.a.output] [--json] [--write file]
// Prints a JSON line with the usage object first (flora's usage parser picks
// it up), then the answer last — flora takes the last JSON block as the output.
import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const model = opt('--model', 'openai/gpt-4o-mini')
let prompt = opt('--prompt', '')
const contextPath = opt('--context-path')
const wantJson = args.includes('--json')
const writeTo = opt('--write')

if (contextPath && process.env.FLORA_CONTEXT) {
  const ctx = JSON.parse(readFileSync(process.env.FLORA_CONTEXT, 'utf8'))
  const value = contextPath.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), ctx)
  prompt += `\n\nContext (${contextPath}): ${JSON.stringify(value)}`
}
if (wantJson) prompt += '\n\nAnswer with a single JSON object and nothing else.'

const key = process.env.OPENROUTER_API_KEY
if (!key) {
  console.error('OPENROUTER_API_KEY is not set')
  process.exit(2)
}

const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-title': 'flora e2e' },
  body: JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
    max_tokens: 300,
    ...(wantJson ? { response_format: { type: 'json_object' } } : {})
  })
})
if (!response.ok) {
  console.error(`openrouter ${response.status}: ${(await response.text()).slice(0, 300)}`)
  process.exit(1)
}
const body = await response.json()
const text = body.choices?.[0]?.message?.content ?? ''
if (writeTo) writeFileSync(writeTo, text)
console.log(JSON.stringify({ model: body.model, usage: body.usage }))
console.log(text)
