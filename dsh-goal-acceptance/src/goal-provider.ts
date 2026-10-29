/** Goal completion policy supplied without modifying the upstream Goal service. */
import GoalService from '@deepseek-ai/dsh-goal'
import type { GoalRef, GoalView } from '@deepseek-ai/dsh-goal'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'

export default class AcceptanceGoalProvider extends GoalService {
  private readonly acceptanceChecks = new Set<(agent: Agent, goal: GoalView) => string | undefined>()

  /** Register a caller-fiber-owned check; unloading the consumer removes it.
   * @param check - synchronous policy evaluated before completion is committed.
   * @returns disposer removing this check.
   */
  registerCompletionCheck(check: (agent: Agent, goal: GoalView) => string | undefined): () => void {
    return this.ctx.effect(() => {
      this.acceptanceChecks.add(check)
      return () => { this.acceptanceChecks.delete(check) }
    })
  }

  /** Reject unaccepted completion before delegating the original mutation.
   * @param agent - exact live owning Agent, validated by the upstream read.
   * @param ref - current goal identity and revision.
   * @returns the completed upstream goal view.
   */
  override complete(agent: Agent, ref: GoalRef): GoalView {
    const goal = this.get(agent)
    if (goal !== undefined && goal.id === ref.id && goal.revision === ref.revision) {
      for (const check of this.acceptanceChecks) {
        const reason = check(agent, goal)
        if (reason !== undefined) throw new HarnessError(reason, 'GOAL_ACCEPTANCE_MISSING')
      }
    }
    return super.complete(agent, ref)
  }
}
