import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawnSync } from 'child_process'

// job-started.sh runs the bundle beside it with a node of the runner's
// externals. Run the real script in a scratch runner directory, with scripts
// in the nodes' places that say which one was run, and with what.
const SCRIPT = path.join(__dirname, '..', 'job-started.sh')

let root: string

function executable(file: string, script: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 })
}

// A node of the runner's externals: says its name and its arguments.
function runnerNode(name: string, script = `echo "${name} $*"`): void {
  executable(path.join(root, 'externals', name, 'bin', 'node'), script)
}

function bundle(): string {
  const file = path.join(root, 'k8s-novolume', 'index.js')
  fs.writeFileSync(file, '')
  return file
}

function jobStarted(pathDirs: string[] = []): {
  status: number | null
  stdout: string
} {
  const run = spawnSync(
    'bash',
    [path.join(root, 'k8s-novolume/job-started.sh')],
    {
      encoding: 'utf8',
      env: { PATH: [...pathDirs, '/usr/bin', '/bin'].join(':') }
    }
  )
  return { status: run.status, stdout: run.stdout }
}

beforeEach(() => {
  // Its real path: the one the script finds for itself where tmpdir is a link.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'job-started-')))
  fs.mkdirSync(path.join(root, 'k8s-novolume'))
  fs.copyFileSync(SCRIPT, path.join(root, 'k8s-novolume', 'job-started.sh'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('job-started.sh', () => {
  it('runs the bundle with node24, which the bundle needs, not with node20', () => {
    runnerNode('node20')
    runnerNode('node24')
    const index = bundle()

    expect(jobStarted()).toEqual({
      status: 0,
      stdout: `node24 ${index} job-started\n`
    })
  })

  it('takes node20 where the runner has no node24', () => {
    runnerNode('node20')
    const index = bundle()

    expect(jobStarted().stdout).toBe(`node20 ${index} job-started\n`)
  })

  it('takes the node on the PATH where the runner brings none', () => {
    executable(path.join(root, 'bin', 'node'), 'echo "path $*"')
    const index = bundle()

    expect(jobStarted([path.join(root, 'bin')])).toEqual({
      status: 0,
      stdout: `path ${index} job-started\n`
    })
  })

  it('never fails the job: not when the bundle fails', () => {
    runnerNode('node24', 'echo "it broke"; exit 7')
    bundle()

    expect(jobStarted()).toEqual({ status: 0, stdout: 'it broke\n' })
  })

  it('never fails the job: not without a node, nor without a bundle', () => {
    bundle()
    expect(jobStarted()).toEqual({ status: 0, stdout: '' })

    fs.rmSync(path.join(root, 'k8s-novolume', 'index.js'))
    runnerNode('node24')
    expect(jobStarted()).toEqual({ status: 0, stdout: '' })
  })
})
