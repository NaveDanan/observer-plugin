import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createServer, DEFAULT_CONFIG, Pipeline, Broadcaster } from '../../apps/daemon/dist/index.js'
import { Store } from '../../packages/storage/dist/index.js'

const sandbox = mkdtempSync(join(tmpdir(), 'observer-brief-smoke-'))
const config = { ...DEFAULT_CONFIG, token: 'local-smoke-token', seats: { control: false, employees: {} } }
const store = new Store({ path: ':memory:' })
const pipeline = new Pipeline({ store, config, onChanges() {} })
const app = await createServer({ store, pipeline, config, broadcaster: new Broadcaster(), webDir: '/nonexistent' })
try {
  await app.listen({ port: 0, host: '127.0.0.1' })
  writeFileSync(join(sandbox, 'config.json'), JSON.stringify({ ...config, port: app.server.address().port }))
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'employee_brief', arguments: {} } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'employee_brief', arguments: { employeeId: 'arjun-mehta', mode: 'review' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'employee_brief', arguments: { employeeId: 'arjun-mehta', mode: 'invalid' } } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n'
  const output = await new Promise((resolveOutput, reject) => {
    const child = spawn(process.execPath, [resolve('release/package/dist/coordination-mcp.js'), '--host', 'codex'], {
      env: { ...process.env, OBSERVER_HOME: sandbox }, windowsHide: true,
    })
    let stdout = '', stderr = ''
    const timeout = setTimeout(() => { child.kill(); reject(new Error('MCP smoke timed out')) }, 15000)
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    child.on('error', error => { clearTimeout(timeout); reject(error) })
    child.on('close', code => { clearTimeout(timeout); code === 0 ? resolveOutput(stdout) : reject(new Error(stderr)) })
    child.stdin.end(input)
  })
  const responses = new Map(output.trim().split('\n').map(line => { const value = JSON.parse(line); return [value.id, value.result] }))
  assert(responses.get(1).tools.some(tool => tool.name === 'employee_brief'))
  assert.equal(JSON.parse(responses.get(2).content[0].text).employees.length, 6)
  const brief = JSON.parse(responses.get(3).content[0].text)
  assert.equal(brief.mode, 'review')
  assert.equal(brief.contract.defaultMode, 'implement')
  assert(brief.instructions.includes('Default mode: review'))
  assert(brief.capabilities.some(capability => capability.id === 'browser' && capability.availability === 'discover-in-host'))
  assert.equal(responses.get(4).isError, true)
  const browserConfig = JSON.parse(readFileSync('release/package/integrations/playwright/mcp.json', 'utf8'))
  assert(browserConfig.mcpServers.playwright.args.includes('--isolated'))
  console.log('Packaged MCP smoke passed: discovery, 6 default employees, selected review contract, invalid-mode error, optional browser configuration.')
} finally {
  await app.close()
  store.close()
  const resolvedSandbox = resolve(sandbox)
  assert(resolvedSandbox.startsWith(resolve(tmpdir()) + sep))
  assert(resolvedSandbox.split(sep).at(-1).startsWith('observer-brief-smoke-'))
  rmSync(resolvedSandbox, { recursive: true, force: true })
}
