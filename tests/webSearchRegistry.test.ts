import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('the production registry selects WebSearch and respects deny, simple mode and provider availability', async () => {
  // A fresh process keeps the unrelated UI/model fixtures in webSearch.test.ts
  // out of this check. Registry, permission matcher, tool and MCP SDK are real.
  const configDir = await mkdtemp(join(tmpdir(), 'claude-web-search-registry-'))
  try {
    const child = Bun.spawn([process.execPath, '--preload', './plugins/bunBundleDev.ts', '--eval', `
      const { getTools } = await import('./src/tools.ts')
      const { getEmptyToolPermissionContext } = await import('./src/Tool.ts')
      const { WebSearchTool } = await import('./src/tools/WebSearchTool/WebSearchTool.ts')
      const context = getEmptyToolPermissionContext()
      const selected = getTools(context).find(tool => tool.name === 'WebSearch')
      const requests = []
      globalThis.fetch = async (url, init = {}) => {
        const body = init.body ? JSON.parse(String(init.body)) : undefined
        const headers = new Headers(init.headers)
        requests.push({ url: String(url), ua: headers.get('user-agent'), auth: headers.has('authorization'), method: body?.method })
        if (!body || body.id === undefined) return new Response(null, { status: 202 })
        const result = body.method === 'initialize'
          ? { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'registry-fixture', version: '1' } }
          : body.method === 'tools/list'
            ? { tools: [{ name: 'web_search', inputSchema: { type: 'object', properties: {} } }] }
            : { content: [{ type: 'text', text: JSON.stringify({ results: [{ title: 'Bun docs', url: 'https://bun.sh/docs', excerpts: ['Registry search excerpt'] }] }) }] }
        return Response.json({ jsonrpc: '2.0', id: body.id, result })
      }
      const input = selected.inputSchema.parse({ query: 'Bun runtime docs' })
      const caller = { abortController: new AbortController() }
      const validation = await selected.validateInput(input, caller)
      if (!validation.result) throw new Error(validation.message)
      const { data } = await selected.call(input, caller)
      const formatted = selected.mapToolResultToToolResultBlockParam(data, 'registry-search')
      const denied = getEmptyToolPermissionContext()
      denied.alwaysDenyRules.session = ['WebSearch']
      const denyRemoved = !getTools(denied).some(tool => tool.name === 'WebSearch')
      process.env.CLAUDE_CODE_SIMPLE = '1'
      const simpleRemoved = !getTools(context).some(tool => tool.name === 'WebSearch')
      delete process.env.CLAUDE_CODE_SIMPLE
      process.env.CLAUDE_CODE_USE_BEDROCK = '1'
      const parallelBedrock = getTools(context).includes(WebSearchTool)
      process.env.CLAUDE_CODE_WEB_SEARCH_PROVIDER = 'anthropic'
      const nativeBedrockRemoved = !getTools(context).some(tool => tool.name === 'WebSearch')
      console.log(JSON.stringify({ actualTool: selected === WebSearchTool, denyRemoved, simpleRemoved, parallelBedrock, nativeBedrockRemoved, content: formatted.content, requests }))
    `], {
      cwd: new URL('..', import.meta.url).pathname,
      env: {
        ...process.env, USER_TYPE: 'external', FEATURE_FLAGS: '',
        CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_CODE_WEB_SEARCH_PROVIDER: '', CLAUDE_CODE_SIMPLE: '',
        CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_USE_VERTEX: '', CLAUDE_CODE_USE_FOUNDRY: '',
        CLAUDE_CODE_REPL: '0', CLAUDE_CODE_VERIFY_PLAN: '0', ENABLE_LSP_TOOL: '0',
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '0',
        ANTHROPIC_MODEL: 'claude-sonnet-4-20250514', ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '', PARALLEL_API_KEY: '',
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' })
    const result = JSON.parse(stdout)
    for (const key of ['actualTool', 'denyRemoved', 'simpleRemoved', 'parallelBedrock', 'nativeBedrockRemoved']) {
      expect(result[key]).toBe(true)
    }
    expect(result.content).toContain('https://bun.sh/docs')
    expect(result.content).toContain('Registry search excerpt')
    expect(result.requests.map((request: any) => request.method)).toContain('tools/list')
    expect(result.requests.map((request: any) => request.method)).toContain('tools/call')
    for (const request of result.requests) {
      expect(request.url).toBe('https://search.parallel.ai/mcp')
      expect(request.ua).toContain('claude-code')
      expect(request.auth).toBe(false)
    }
  } finally {
    await rm(configDir, { recursive: true, force: true })
  }
})
