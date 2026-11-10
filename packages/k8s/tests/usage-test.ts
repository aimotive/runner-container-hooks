import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import {
  formatResourceUsageReport,
  usageReadCommand,
  usageSampleCommand,
  usageSamplerStartCommand
} from '../src/k8s/utils'

const GiB = 1024 ** 3

// These scripts run inside the job container; execute them with the local sh
// against a scratch cgroup dir to check what they read and write.
function runSh(script: string): string {
  return execFileSync('sh', ['-c', script], { encoding: 'utf8' })
}

let root: string
let cgroup: string
let peaks: string

function setMemory(current: number, stat: { [key: string]: number }): void {
  fs.writeFileSync(path.join(cgroup, 'memory.current'), `${current}\n`)
  fs.writeFileSync(
    path.join(cgroup, 'memory.stat'),
    Object.entries(stat)
      .map(([k, v]) => `${k} ${v}\n`)
      .join('')
  )
}

function readPeaks(): string {
  return fs.readFileSync(peaks, 'utf8')
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'))
  cgroup = path.join(root, 'cgroup')
  peaks = path.join(root, 'peaks')
  fs.mkdirSync(cgroup)
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('usageSampleCommand', () => {
  it('keeps the memory held and the working set apart from the page cache', () => {
    // A build's: 40Gi charged, 34Gi of it page cache (1Gi tmpfs), half of the
    // cache inactive, 0.5Gi of reclaimable dentries and inodes.
    setMemory(40 * GiB, {
      anon: 5 * GiB,
      file: 34 * GiB,
      shmem: 1 * GiB,
      inactive_file: 17 * GiB,
      slab_reclaimable: 0.5 * GiB
    })
    runSh(usageSampleCommand(cgroup, peaks))
    expect(readPeaks()).toBe(`held_peak=${6.5 * GiB}\nws_peak=${23 * GiB}\n`)
  })

  it('keeps each peak until a sample beats it', () => {
    setMemory(10 * GiB, { file: 2 * GiB, inactive_file: 1 * GiB })
    runSh(usageSampleCommand(cgroup, peaks))
    // Less held, but a larger working set: only the working set moves.
    setMemory(20 * GiB, { file: 15 * GiB, inactive_file: 2 * GiB })
    runSh(usageSampleCommand(cgroup, peaks))
    expect(readPeaks()).toBe(`held_peak=${8 * GiB}\nws_peak=${18 * GiB}\n`)
  })

  it('writes nothing without a cgroup', () => {
    runSh(usageSampleCommand(cgroup, peaks))
    expect(fs.existsSync(peaks)).toBe(false)
  })
})

describe('usageSamplerStartCommand', () => {
  it('does not start on cgroup v1, without memory.stat', () => {
    fs.writeFileSync(peaks, 'held_peak=1\n')
    runSh(usageSamplerStartCommand(cgroup, peaks, 1))
    // The early exit leaves even a stale file alone: nothing ran.
    expect(readPeaks()).toBe('held_peak=1\n')
  })

  it('samples in the background and returns at once', async () => {
    setMemory(3 * GiB, { file: 1 * GiB, inactive_file: 1 * GiB })
    fs.writeFileSync(peaks, `held_peak=${99 * GiB}\nws_peak=${99 * GiB}\n`)
    const started = Date.now()
    runSh(usageSamplerStartCommand(cgroup, peaks, 1))
    expect(Date.now() - started).toBeLessThan(1000)
    // A stale file from an earlier job in the same container is cleared.
    for (let i = 0; i < 40 && !fs.existsSync(peaks); i++) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    expect(readPeaks()).toBe(`held_peak=${2 * GiB}\nws_peak=${2 * GiB}\n`)
    // The loop stops at its next sample once the cgroup is gone.
    fs.rmSync(cgroup, { recursive: true })
  })
})

describe('usageReadCommand', () => {
  it('reads the peaks, the limit, the events and the CPU', () => {
    setMemory(30 * GiB, { file: 20 * GiB, inactive_file: 10 * GiB })
    fs.writeFileSync(path.join(cgroup, 'memory.peak'), `${60 * GiB}\n`)
    fs.writeFileSync(path.join(cgroup, 'memory.max'), `${60 * GiB}\n`)
    fs.writeFileSync(
      path.join(cgroup, 'memory.events'),
      'low 0\nhigh 0\nmax 312\noom 0\noom_kill 0\n'
    )
    fs.writeFileSync(
      path.join(cgroup, 'cpu.stat'),
      'usage_usec 2130000000\nuser_usec 2000000000\n'
    )
    fs.writeFileSync(peaks, `held_peak=${12 * GiB}\nws_peak=${15 * GiB}\n`)
    const raw = runSh(usageReadCommand(cgroup, peaks))
    // The last sample raised the working set peak to 20Gi.
    expect(raw).toContain(`held_peak=${12 * GiB}\nws_peak=${20 * GiB}\n`)
    expect(formatResourceUsageReport(raw)).toBe(
      'peak memory: 12Gi / 60Gi limit (20%) held, page cache left out' +
        ' | working set peak: 20Gi' +
        ' | with the page cache: 60Gi, the limit reached 312 times, 0 OOM kills' +
        ' | cpu: 2130s total'
    )
  })
})

describe('formatResourceUsageReport', () => {
  it('says the cgroup peak includes the cache when there was no sampler', () => {
    expect(
      formatResourceUsageReport(
        `mem_peak=${60 * GiB}\nmem_limit=${60 * GiB}\nmem_max_events=4\noom_kills=1\ncpu_usec=1500000\n`
      )
    ).toBe(
      'peak memory: 60Gi / 60Gi limit (100%) page cache included, the limit reached 4 times, 1 OOM kill' +
        ' | cpu: 1.5s total'
    )
  })

  it('reads an unlimited cgroup and a kernel without counters', () => {
    expect(
      formatResourceUsageReport(
        `held_peak=${GiB}\nmem_peak=${2 * GiB}\nmem_limit=max\ncpu_usec=na\n`
      )
    ).toBe(
      'peak memory: 1Gi (no limit) held, page cache left out | with the page cache: 2Gi'
    )
    expect(formatResourceUsageReport('mem_peak=na\nmem_limit=na\n')).toBe(
      'peak memory: n/a (no cgroup peak counter on this kernel)'
    )
  })
})
