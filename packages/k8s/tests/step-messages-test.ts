import {
  createStringSink,
  execStatusExitCode,
  exitCodeHint,
  exitCodeOf,
  slowSyncNotice,
  SLOW_SYNC_SECONDS,
  withExitCode
} from '../src/k8s/utils'

describe('createStringSink', () => {
  it('collects buffer and string chunks', async () => {
    const sink = createStringSink()
    sink.stream.write(Buffer.from('tar: '))
    sink.stream.write('something failed')
    await new Promise(resolve => sink.stream.end(resolve))

    expect(sink.contents()).toBe('tar: something failed')
    expect(sink.size()).toBe('tar: something failed'.length)
  })

  it('is empty when nothing was written', () => {
    const sink = createStringSink()
    expect(sink.size()).toBe(0)
    expect(sink.contents()).toBe('')
  })
})

describe('execStatusExitCode', () => {
  const nonZeroExit = (code: string): object => ({
    status: 'Failure',
    reason: 'NonZeroExitCode',
    message: `command terminated with non-zero exit code: error executing command [sh -e /__w/_temp/x.sh], exit code ${code}`,
    details: { causes: [{ reason: 'ExitCode', message: code }] }
  })

  it('reads the exit code of a command that ran and failed', () => {
    expect(execStatusExitCode(nonZeroExit('2'))).toBe(2)
    expect(execStatusExitCode(nonZeroExit('137'))).toBe(137)
  })

  it('is undefined for failures that are not an exit code', () => {
    expect(execStatusExitCode(undefined)).toBeUndefined()
    expect(
      execStatusExitCode({
        status: 'Failure',
        message: 'container not found ("job")'
      })
    ).toBeUndefined()
    expect(
      execStatusExitCode({
        status: 'Failure',
        details: { causes: [{ reason: 'Other', message: '3' }] }
      })
    ).toBeUndefined()
    expect(execStatusExitCode(nonZeroExit('not-a-number'))).toBeUndefined()
  })
})

describe('withExitCode / exitCodeOf', () => {
  it('round-trips the exit code on an error', () => {
    const err = withExitCode(new Error('boom'), 3)
    expect(err.message).toBe('boom')
    expect(exitCodeOf(err)).toBe(3)
  })

  it('leaves errors without an exit code untouched', () => {
    expect(exitCodeOf(withExitCode(new Error('boom')))).toBeUndefined()
    expect(exitCodeOf(new Error('boom'))).toBeUndefined()
    expect(exitCodeOf('boom')).toBeUndefined()
    expect(exitCodeOf(undefined)).toBeUndefined()
  })
})

describe('slowSyncNotice', () => {
  it('stays quiet when the sync is fast', () => {
    expect(slowSyncNotice(0.2, 0.1)).toBeUndefined()
    expect(slowSyncNotice(SLOW_SYNC_SECONDS - 0.2, 0.1)).toBeUndefined()
  })

  it('explains where the time went when the sync is slow', () => {
    expect(slowSyncNotice(3.14, 4.26)).toBe(
      'Note: the runner spent 7.4s moving step files to and from the job pod ' +
        '(3.1s before, 4.3s after the step). ' +
        'This is infrastructure overhead, not time spent in your step.'
    )
  })
})

describe('exitCodeHint', () => {
  it('points at the OOM killer for exit code 137', () => {
    expect(exitCodeHint(137)).toContain('out-of-memory killer')
  })

  it('has nothing to add for ordinary exit codes', () => {
    expect(exitCodeHint(0)).toBeUndefined()
    expect(exitCodeHint(1)).toBeUndefined()
    expect(exitCodeHint(2)).toBeUndefined()
  })
})
