import * as core from '@actions/core'
import type { V1ContainerStatus, V1Pod } from '@kubernetes/client-node'
import { notePodHeld } from './placement'
import { PodPhase, formatError, sleep } from './utils'

// Waiting for a pod to run: the hook reads it at a steady pace, one read a
// poll, until it has reached a phase the hook waits for. The back-off this
// replaces doubled its sleep up to 20 s, so a pod that ran 32 s after it was
// created was seen at 51 s: up to 20 s of a job's "Initialize containers" was
// the hook asleep beside a pod that ran. A watch would see it at once too, but
// needs the `watch` verb on pods, which the hooks' role does not have.

export const POD_POLL_SECONDS = 1

// A namespaced get-by-name of a pod, its status with it.
export type PodStatusReader = (name: string) => Promise<V1Pod>

// The clock the wait goes by: a test brings its own.
export interface WaitClock {
  now: () => number
  sleep: (ms: number) => Promise<void>
}

const POD_PHASES = new Set<string>([
  PodPhase.PENDING,
  PodPhase.RUNNING,
  PodPhase.SUCCEEDED,
  PodPhase.FAILED,
  PodPhase.UNKNOWN
])

export function podPhase(pod: V1Pod): PodPhase {
  const phase = pod.status?.phase
  return phase && POD_PHASES.has(phase) ? (phase as PodPhase) : PodPhase.UNKNOWN
}

// A concise, human-readable account of what each (init)container is doing
// while the pod is not yet ready — image being pulled, waiting reason/message
// (ContainerCreating, ImagePullBackOff, ...), or running/terminated state.
// Surfaces image-pull progress and stalls on the GitHub Actions UI.
export function podProgress(
  pod: V1Pod,
  podName: string,
  phase: PodPhase
): string {
  const lines: string[] = []
  const describe = (
    statuses: V1ContainerStatus[] | undefined,
    kind: string
  ): void => {
    for (const cs of statuses || []) {
      const state = cs.state || {}
      if (state.waiting) {
        const reason = state.waiting.reason || 'Waiting'
        const detail = state.waiting.message
          ? ` - ${state.waiting.message}`
          : ''
        lines.push(`${kind} ${cs.name} [${cs.image}]: ${reason}${detail}`)
      } else if (state.running) {
        lines.push(`${kind} ${cs.name} [${cs.image}]: Running`)
      } else if (state.terminated) {
        lines.push(
          `${kind} ${cs.name} [${cs.image}]: Terminated (${state.terminated.reason})`
        )
      }
    }
  }
  describe(pod.status?.initContainerStatuses, 'init')
  describe(pod.status?.containerStatuses, 'container')
  return (
    `Waiting for pod ${podName} (phase ${phase})` +
    (lines.length ? `\n  ${lines.join('\n  ')}` : '')
  )
}

// Say what the pod is doing, only when it changed since the last poll, and
// keep why it has no node. Best-effort: logging never breaks the wait.
function logPodProgress(
  pod: V1Pod,
  podName: string,
  phase: PodPhase,
  last: string
): string {
  try {
    notePodHeld(pod)
    const msg = podProgress(pod, podName, phase)
    if (msg !== last) {
      core.info(msg)
      return msg
    }
  } catch {
    // Nothing to say of this read.
  }
  return last
}

// Read the pod every POD_POLL_SECONDS until it is in one of `awaitingPhases`.
// A phase outside `backOffPhases`, or a read that fails, ends the wait with an
// error, and so does `maxTimeSeconds` (none without it): the pod is read once
// more when the time is up, and no later.
export async function waitForPod(
  read: PodStatusReader,
  podName: string,
  awaitingPhases: Set<PodPhase>,
  backOffPhases: Set<PodPhase>,
  maxTimeSeconds?: number,
  clock: WaitClock = { now: Date.now, sleep }
): Promise<void> {
  const deadline =
    maxTimeSeconds && maxTimeSeconds > 0
      ? clock.now() + maxTimeSeconds * 1000
      : undefined
  let phase: PodPhase = PodPhase.UNKNOWN
  let lastProgress = ''
  try {
    while (true) {
      const pod = await read(podName)
      phase = podPhase(pod)
      if (awaitingPhases.has(phase)) {
        core.info(`Pod ${podName} reached phase ${phase}`)
        return
      }

      if (!backOffPhases.has(phase)) {
        throw new Error(
          `Pod ${podName} is unhealthy with phase status ${phase}`
        )
      }
      lastProgress = logPodProgress(pod, podName, phase, lastProgress)

      const left = deadline === undefined ? Infinity : deadline - clock.now()
      if (left <= 0) {
        throw new Error('backoff timeout')
      }
      await clock.sleep(Math.min(POD_POLL_SECONDS * 1000, left))
    }
  } catch (error) {
    throw new Error(
      `Pod ${podName} is unhealthy with phase status ${phase}: ${formatError(error)}`
    )
  }
}
