import * as core from '@actions/core'
import type { V1Pod } from '@kubernetes/client-node'
import { podHeld } from '../src/k8s/placement'
import {
  POD_POLL_SECONDS,
  podPhase,
  podProgress,
  waitForPod,
  WaitClock
} from '../src/k8s/pod-wait'
import { PodPhase } from '../src/k8s/utils'

const RUNNING = new Set([PodPhase.RUNNING])
const PENDING = new Set([PodPhase.PENDING])

const pod = (
  phase: string,
  status: object = {},
  name = 'r-1-workflow'
): V1Pod => ({ metadata: { name }, status: { phase, ...status } }) as V1Pod

// The pods a read gives, one after another; the last one from then on.
const reads = (...pods: V1Pod[]): jest.Mock<Promise<V1Pod>, [string]> =>
  jest.fn<Promise<V1Pod>, [string]>(async () =>
    pods.length > 1 ? (pods.shift() as V1Pod) : pods[0]
  )

// A clock that moves only while the wait sleeps, and keeps each sleep.
function clockOf(): { clock: WaitClock; slept: number[] } {
  let at = 1_700_000_000_000
  const slept: number[] = []
  return {
    slept,
    clock: {
      now: () => at,
      sleep: async ms => {
        slept.push(ms)
        at += ms
      }
    }
  }
}

describe('waiting for a pod', () => {
  let info: jest.SpyInstance

  beforeEach(() => {
    info = jest.spyOn(core, 'info').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('sees a pod run within a poll of it running, however long it took', async () => {
    // Pending for 32 s. The back-off that doubled to 20 s slept 1, 2, 4, 8,
    // 16 and 20 s, and saw this pod at 51 s.
    const pending = Array.from({ length: 32 }, () => pod('Pending'))
    const read = reads(...pending, pod('Running'))
    const { clock, slept } = clockOf()

    await waitForPod(read, 'r-1-workflow', RUNNING, PENDING, 600, clock)

    expect(slept).toHaveLength(32)
    expect(new Set(slept)).toEqual(new Set([POD_POLL_SECONDS * 1000]))
    expect(info).toHaveBeenLastCalledWith(
      'Pod r-1-workflow reached phase Running'
    )
  })

  it('reads the pod once a poll', async () => {
    const read = reads(pod('Pending'), pod('Pending'), pod('Running'))
    const { clock, slept } = clockOf()

    await waitForPod(read, 'r-1-workflow', RUNNING, PENDING, 600, clock)

    expect(read).toHaveBeenCalledTimes(3)
    expect(read).toHaveBeenCalledWith('r-1-workflow')
    expect(slept).toEqual([1000, 1000])
  })

  it('does not sleep for a pod that already runs', async () => {
    const { clock, slept } = clockOf()
    await waitForPod(reads(pod('Running')), 'p', RUNNING, PENDING, 600, clock)
    expect(slept).toEqual([])
  })

  it('says what the pod is doing only when that changed', async () => {
    const init = {
      initContainerStatuses: [
        {
          name: 'fs-init',
          image: 'runner:1',
          state: { waiting: { reason: 'PodInitializing' } }
        }
      ]
    }
    const pulling = {
      initContainerStatuses: [
        {
          name: 'fs-init',
          image: 'runner:1',
          state: { terminated: { reason: 'Completed' } }
        }
      ],
      containerStatuses: [
        {
          name: 'job',
          image: 'ubuntu:24.04',
          state: {
            waiting: { reason: 'ErrImagePull', message: 'manifest unknown' }
          }
        }
      ]
    }
    const read = reads(
      pod('Pending'),
      pod('Pending'),
      pod('Pending', init),
      pod('Pending', init),
      pod('Pending', pulling),
      pod('Running')
    )

    await waitForPod(
      read,
      'r-1-workflow',
      RUNNING,
      PENDING,
      600,
      clockOf().clock
    )

    expect(info.mock.calls.map(([line]) => line)).toEqual([
      'Waiting for pod r-1-workflow (phase Pending)',
      'Waiting for pod r-1-workflow (phase Pending)\n' +
        '  init fs-init [runner:1]: PodInitializing',
      'Waiting for pod r-1-workflow (phase Pending)\n' +
        '  init fs-init [runner:1]: Terminated (Completed)\n' +
        '  container job [ubuntu:24.04]: ErrImagePull - manifest unknown',
      'Pod r-1-workflow reached phase Running'
    ])
  })

  it('keeps why the pod had no node, for the line of its times', async () => {
    const unschedulable = pod(
      'Pending',
      {
        conditions: [
          {
            type: 'PodScheduled',
            status: 'False',
            reason: 'Unschedulable',
            message: '0/31 nodes are available: 31 Insufficient cpu.'
          }
        ]
      },
      'held-workflow'
    )
    const read = reads(unschedulable, pod('Running', {}, 'held-workflow'))

    await waitForPod(
      read,
      'held-workflow',
      RUNNING,
      PENDING,
      600,
      clockOf().clock
    )

    expect(podHeld('held-workflow')).toEqual({
      reason: 'Unschedulable',
      message: '0/31 nodes are available: 31 Insufficient cpu.'
    })
  })

  it('gives up when the time is up, after one last read, and no later', async () => {
    const read = reads(pod('Pending'))
    const { clock, slept } = clockOf()

    await expect(
      waitForPod(read, 'r-1-workflow', RUNNING, PENDING, 3, clock)
    ).rejects.toThrow(
      'Pod r-1-workflow is unhealthy with phase status Pending: backoff timeout'
    )
    // Read as it began and after each of three seconds.
    expect(slept).toEqual([1000, 1000, 1000])
    expect(read).toHaveBeenCalledTimes(4)
  })

  it('cuts its last sleep to the time left', async () => {
    const read = reads(pod('Pending'))
    const { clock, slept } = clockOf()

    await expect(
      waitForPod(read, 'r-1-workflow', RUNNING, PENDING, 2.5, clock)
    ).rejects.toThrow('backoff timeout')
    expect(slept).toEqual([1000, 1000, 500])
  })

  it('takes a pod that runs at the last read', async () => {
    const read = reads(pod('Pending'), pod('Pending'), pod('Running'))
    await expect(
      waitForPod(read, 'r-1-workflow', RUNNING, PENDING, 2, clockOf().clock)
    ).resolves.toBeUndefined()
  })

  it('waits on without a limit when it is given none', async () => {
    const pending = Array.from({ length: 1000 }, () => pod('Pending'))
    for (const limit of [undefined, 0, -1]) {
      const read = reads(...pending, pod('Running'))
      const { clock, slept } = clockOf()
      await waitForPod(read, 'p', RUNNING, PENDING, limit, clock)
      expect(slept).toHaveLength(1000)
    }
  })

  it('ends on a phase it does not wait through', async () => {
    const { clock, slept } = clockOf()
    await expect(
      waitForPod(reads(pod('Failed')), 'p', RUNNING, PENDING, 600, clock)
    ).rejects.toThrow(/^Pod p is unhealthy with phase status Failed/)
    expect(slept).toEqual([])
  })

  it('ends on a read that fails, with what the read said', async () => {
    const read = jest.fn(async () => {
      throw new Error('pods "p" not found')
    })
    await expect(
      waitForPod(read, 'p', RUNNING, PENDING, 600, clockOf().clock)
    ).rejects.toThrow(
      'Pod p is unhealthy with phase status Unknown: pods "p" not found'
    )
  })

  it('takes a phase it does not know, or none, as Unknown', async () => {
    expect(podPhase(pod('Evicted'))).toBe(PodPhase.UNKNOWN)
    expect(podPhase({} as V1Pod)).toBe(PodPhase.UNKNOWN)
    expect(podPhase(pod('Pending'))).toBe(PodPhase.PENDING)
    // A step pod is waited for through Unknown too.
    const read = reads({} as V1Pod, pod('Running'))
    await waitForPod(
      read,
      'p',
      RUNNING,
      new Set([PodPhase.PENDING, PodPhase.UNKNOWN]),
      600,
      clockOf().clock
    )
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('waits on beside a pod it cannot describe', async () => {
    const odd = pod('Pending', { initContainerStatuses: [null] })
    expect(() => podProgress(odd, 'p', PodPhase.PENDING)).toThrow()
    const read = reads(odd, pod('Running'))
    await waitForPod(read, 'p', RUNNING, PENDING, 600, clockOf().clock)
    expect(info.mock.calls).toEqual([['Pod p reached phase Running']])
  })
})
