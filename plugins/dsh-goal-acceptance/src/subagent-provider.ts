/** Initial delegation context supplied by an opt-in upstream-service subclass. */
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentActivation, SubagentActivationSpec } from '@deepseek-ai/dsh-subagent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

export default class AcceptanceSubagentProvider extends SubagentRuntime {
  private readonly acceptanceContexts = new Set<(parent: Agent) => readonly ContentBlock[]>()

  /** Register a caller-fiber-owned synchronous context contribution.
   * @param contribute - retained context for the exact live parent.
   * @returns disposer removing this contribution.
   */
  registerPromptContext(contribute: (parent: Agent) => readonly ContentBlock[]): () => void {
    return this.ctx.effect(() => {
      this.acceptanceContexts.add(contribute)
      return () => { this.acceptanceContexts.delete(contribute) }
    })
  }

  override startActivation(spec: SubagentActivationSpec & { readonly childId: SessionId }): Promise<SubagentActivation & { readonly messageId: MessageId }>
  override startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation>
  /** Add policy context before the upstream provider admits a child.
   * @param spec - unchanged activation metadata plus the original prompt.
   * @returns the original activation, including reserved-child message identity.
   */
  override async startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation> {
    const provider = this.getProvider(spec.provider)
    if (provider === undefined || this.ctx.get('agents')?.get(spec.request.parent.id) !== spec.request.parent
      || (spec.childId !== undefined && provider.prepareContinuable === undefined)) {
      return super.startActivation(spec)
    }
    const additions = [...this.acceptanceContexts].flatMap(contribute => contribute(spec.request.parent))
    return super.startActivation(additions.length === 0 ? spec : {
      ...spec, request: { ...spec.request, prompt: [...spec.request.prompt, ...additions] },
    })
  }
}
