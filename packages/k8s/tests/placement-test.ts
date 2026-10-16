import * as core from '@actions/core'
import {
  ENV_RUNNER_POD_NAME,
  logRunnerPlacement,
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
