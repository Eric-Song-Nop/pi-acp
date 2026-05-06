import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import type { PiRpcEvent } from '../../src/pi-rpc/process.js'

type SessionUpdateMsg = Parameters<AgentSideConnection['sessionUpdate']>[0]

export class FakeAgentSideConnection {
  readonly updates: SessionUpdateMsg[] = []
  requestPermissionHandler?: (
    params: Record<string, unknown>
  ) => Promise<Record<string, unknown>> | Record<string, unknown>
  extMethodHandler?: (
    method: string,
    params: Record<string, unknown>
  ) => Promise<Record<string, unknown>> | Record<string, unknown>
  readonly extNotifications: Array<{ method: string; params: Record<string, unknown> }> = []

  async sessionUpdate(msg: SessionUpdateMsg): Promise<void> {
    this.updates.push(msg)
  }

  async requestPermission(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.requestPermissionHandler) throw new Error('requestPermission unavailable')
    return this.requestPermissionHandler(params)
  }

  async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.extMethodHandler) throw new Error('extMethod unavailable')
    return this.extMethodHandler(method, params)
  }

  async extNotification(method: string, params: Record<string, unknown>): Promise<void> {
    this.extNotifications.push({ method, params })
  }
}

export class FakePiRpcProcess {
  private handlers: Array<(ev: PiRpcEvent) => void> = []

  // spies
  readonly prompts: Array<{ message: string; attachments: unknown[] }> = []
  readonly extensionUiResponses: unknown[] = []
  abortCount = 0
  promptHandler?: (message: string, attachments: unknown[]) => Promise<void> | void
  commands: unknown = { commands: [] }

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler)
    }
  }

  emit(ev: PiRpcEvent) {
    for (const h of this.handlers) h(ev)
  }

  async prompt(message: string, attachments: unknown[] = []): Promise<void> {
    this.prompts.push({ message, attachments })
    await this.promptHandler?.(message, attachments)
  }

  async abort(): Promise<void> {
    this.abortCount += 1
  }

  async getState(): Promise<any> {
    return {}
  }

  async getAvailableModels(): Promise<any> {
    return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
  }

  async getMessages(): Promise<any> {
    return { messages: [] }
  }

  async getCommands(): Promise<any> {
    return this.commands
  }

  sendExtensionUiResponse(response: unknown): void {
    this.extensionUiResponses.push(response)
  }
}

export function asAgentConn(conn: FakeAgentSideConnection): AgentSideConnection {
  // We only implement the method(s) used by PiAcpSession in tests.
  return conn as unknown as AgentSideConnection
}
