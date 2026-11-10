import * as core from '@actions/core'
import {
  ENV_RUNNER_POD_NAME,
  logPodTimes,
  logRunnerPlacement,
  notePodHeld,
  podHeld,
  podTimesLine,
  PodTimes,
  runnerPlacementLine
} from '../src/k8s/placement'

describe('logRunnerPlacement', () => {
  let info: jest.SpyInstance
  let debug: jest.SpyInstance
  const saved = process.env[ENV_RUNNER_POD_NAME]

  beforeEach(() => {
    info = jest.spyOn(core, 'info').mockImplementation(() => {})
    debug = jest.spyOn(core, 'debug').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
    if (saved === undefined) {
      delete process.env[ENV_RUNNER_POD_NAME]
    } else {
      process.env[ENV_RUNNER_POD_NAME] = saved
    }
  })

  it('says the node the runner pod runs on, as the job pod line does', async () => {
    process.env[ENV_RUNNER_POD_NAME] =
      'aim-k8s-runner-aidrive-base-v2-vfrnv-runner-h22gs'
    const read = jest.fn(async () => ({
      spec: { nodeName: 'scorpio029.ad.adasworks.com' }
    }))

    const node = await logRunnerPlacement(read)

    expect(read).toHaveBeenCalledWith(
      'aim-k8s-runner-aidrive-base-v2-vfrnv-runner-h22gs'
    )
    expect(node).toBe('scorpio029.ad.adasworks.com')
    expect(info).toHaveBeenCalledWith(
      'Runner pod aim-k8s-runner-aidrive-base-v2-vfrnv-runner-h22gs is running on node scorpio029.ad.adasworks.com'
    )
  })

  it('takes the pod it is given over the environment', async () => {
    process.env[ENV_RUNNER_POD_NAME] = 'from-env'
    const read = jest.fn(async () => ({ spec: { nodeName: 'virgo006' } }))
    await logRunnerPlacement(read, 'given')
    expect(read).toHaveBeenCalledWith('given')
  })

  it('says nothing, and asks nothing, without the runner pod name', async () => {
    delete process.env[ENV_RUNNER_POD_NAME]
    const read = jest.fn()
    expect(await logRunnerPlacement(read)).toBeUndefined()
    expect(read).not.toHaveBeenCalled()
    expect(info).not.toHaveBeenCalled()
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining(ENV_RUNNER_POD_NAME)
    )
  })

  it('never fails the job: a refused read is a debug line', async () => {
    const read = jest.fn(async () => {
      throw new Error('pods "x" is forbidden')
    })
    expect(await logRunnerPlacement(read, 'x')).toBeUndefined()
    expect(info).not.toHaveBeenCalled()
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining('Could not read the node of runner pod x')
    )
  })

  it('says nothing of a pod not scheduled yet', async () => {
    const read = jest.fn(async () => ({ spec: {} }))
    expect(await logRunnerPlacement(read, 'x')).toBeUndefined()
    expect(info).not.toHaveBeenCalled()
  })

  it('writes the line the workflow dashboard reads', () => {
    expect(runnerPlacementLine('r-1', 'virgo003.ad.adasworks.com')).toBe(
      'Runner pod r-1 is running on node virgo003.ad.adasworks.com'
    )
  })
})

describe("the job pod's times", () => {
  let info: jest.SpyInstance
  let debug: jest.SpyInstance

  beforeEach(() => {
    info = jest.spyOn(core, 'info').mockImplementation(() => {})
    debug = jest.spyOn(core, 'debug').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  // A workflow pod as the API server has it once it runs, its times as the
  // client gives them: Dates.
  const running = (name = 'r-1-workflow'): PodTimes => ({
    metadata: {
      name,
      creationTimestamp: new Date('2026-11-10T12:00:00Z')
    },
    status: {
      conditions: [
        {
          type: 'PodReadyToStartContainers',
          status: 'True',
          lastTransitionTime: new Date('2026-11-10T12:00:06Z')
        },
        {
          type: 'Initialized',
          status: 'True',
          lastTransitionTime: new Date('2026-11-10T12:00:09Z')
        },
        {
          type: 'PodScheduled',
          status: 'True',
          lastTransitionTime: new Date('2026-11-10T12:00:03Z')
        }
      ],
      initContainerStatuses: [
        {
          name: 'fs-init',
          state: {
            terminated: { startedAt: new Date('2026-11-10T12:00:05Z') }
          }
        }
      ],
      containerStatuses: [
        {
          name: 'redis',
          state: { running: { startedAt: new Date('2026-11-10T12:00:12Z') } }
        },
        {
          name: 'job',
          state: { running: { startedAt: new Date('2026-11-10T12:00:41Z') } }
        }
      ]
    }
  })

  it("writes the line the workflow dashboard reads, by the pod's own times", () => {
    expect(podTimesLine(running(), 'job')).toBe(
      '[pod] created=2026-11-10T12:00:00Z scheduled=2026-11-10T12:00:03Z ' +
        'init_started=2026-11-10T12:00:05Z initialized=2026-11-10T12:00:09Z ' +
        'started=2026-11-10T12:00:41Z'
    )
  })

  it('takes the first start of several init containers, and times given as text', () => {
    const pod = running()
    pod.status!.initContainerStatuses = [
      {
        name: 'second',
        state: { running: { startedAt: '2026-11-10T12:00:07Z' } }
      },
      {
        name: 'first',
        state: { terminated: { startedAt: '2026-11-10T12:00:04Z' } }
      },
      { name: 'waiting', state: {} }
    ]
    expect(podTimesLine(pod, 'job')).toContain(
      ' init_started=2026-11-10T12:00:04Z '
    )
  })

  it('leaves out a time the pod does not have', () => {
    const pod = running()
    pod.status!.initContainerStatuses = undefined
    pod.status!.containerStatuses = [{ name: 'job', state: {} }]
    expect(podTimesLine(pod, 'job')).toBe(
      '[pod] created=2026-11-10T12:00:00Z scheduled=2026-11-10T12:00:03Z ' +
        'initialized=2026-11-10T12:00:09Z'
    )
  })

  it("takes a condition's time only once it is true", () => {
    const pod = running()
    pod.status!.conditions = [
      {
        type: 'PodScheduled',
        status: 'False',
        reason: 'Unschedulable',
        lastTransitionTime: new Date('2026-11-10T12:00:00Z')
      }
    ]
    expect(podTimesLine(pod, 'job', undefined)).not.toContain('scheduled=')
  })

  it("says why a pod had no node at first, in the scheduler's words", () => {
    const pod = running('held-workflow')
    notePodHeld({
      metadata: { name: 'held-workflow' },
      status: {
        conditions: [
          {
            type: 'PodScheduled',
            status: 'False',
            reason: 'Unschedulable',
            message:
              '0/31 nodes are available: 3 Insufficient cpu,\n 28 node(s) ' +
              "didn't match Pod's node affinity/selector."
          }
        ]
      }
    })
    // Read again once it has a node: the condition says no more of it.
    notePodHeld(pod)

    expect(podHeld('held-workflow')?.reason).toBe('Unschedulable')
    expect(podTimesLine(pod, 'job')).toBe(
      '[pod] created=2026-11-10T12:00:00Z scheduled=2026-11-10T12:00:03Z ' +
        'init_started=2026-11-10T12:00:05Z initialized=2026-11-10T12:00:09Z ' +
        'started=2026-11-10T12:00:41Z | Unschedulable: 0/31 nodes are ' +
        "available: 3 Insufficient cpu, 28 node(s) didn't match Pod's node " +
        'affinity/selector.'
    )
    // Another pod's wait is not this one's.
    expect(podTimesLine(running('other-workflow'), 'job')).not.toContain('|')
  })

  it('cuts a long message short', () => {
    notePodHeld({
      metadata: { name: 'long-workflow' },
      status: {
        conditions: [
          {
            type: 'PodScheduled',
            status: 'False',
            reason: 'Unschedulable',
            message: 'x'.repeat(1000)
          }
        ]
      }
    })
    expect(podHeld('long-workflow')?.message).toHaveLength(300)
  })

  it('says nothing of a pod without a time', () => {
    expect(podTimesLine({}, 'job')).toBeUndefined()
    logPodTimes({ status: {} }, 'job')
    expect(info).not.toHaveBeenCalled()
  })

  it('prints the line', () => {
    logPodTimes(running(), 'job')
    expect(info).toHaveBeenCalledWith(
      expect.stringMatching(/^\[pod\] created=2026-11-10T12:00:00Z .* started=/)
    )
  })

  it('never fails the job: a pod it cannot make sense of is a debug line', () => {
    const pod = {
      status: { conditions: 'none' }
    } as unknown as PodTimes
    expect(() => logPodTimes(pod, 'job')).not.toThrow()
    expect(info).not.toHaveBeenCalled()
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining('Could not read the times of the job pod')
    )
  })
})
