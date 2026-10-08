import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { clearStaleTempCommand, mergeTempDirCommand } from '../src/k8s/utils'

// These scripts run inside the job container; execute them with the local sh
// against a scratch dir to check what they actually do to the filesystem.
function runSh(script: string): string {
  return execFileSync('sh', ['-c', script], { encoding: 'utf8' })
}

function write(file: string, content = ''): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function list(dir: string): string[] {
  return fs.readdirSync(dir).sort()
}

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'temp-dir-commands-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('mergeTempDirCommand', () => {
  let src: string
  let dst: string

  beforeEach(() => {
    src = path.join(root, '_temp_pre')
    dst = path.join(root, '_temp')
  })

  it('replaces _runner_file_commands with the incoming set only', () => {
    write(`${dst}/_runner_file_commands/set_output_old-step`, 'stale')
    write(`${dst}/_runner_file_commands/save_state_old-job`, 'stale')
    write(`${src}/_runner_file_commands/set_output_new-step`, '')
    write(`${src}/_runner_file_commands/set_env_new-step`, '')

    runSh(mergeTempDirCommand(src, dst))

    expect(list(`${dst}/_runner_file_commands`)).toEqual([
      'set_env_new-step',
      'set_output_new-step'
    ])
  })

  it('leaves an empty _runner_file_commands when the source has none', () => {
    write(`${dst}/_runner_file_commands/set_output_old-step`, 'stale')
    write(`${src}/step.sh`, 'echo hi')

    runSh(mergeTempDirCommand(src, dst))

    expect(list(`${dst}/_runner_file_commands`)).toEqual([])
  })

  it('merges the rest of _temp, overwriting existing files', () => {
    write(`${dst}/_github_home/old.txt`, 'old')
    write(`${dst}/keep.sh`, 'keep')
    write(`${dst}/overwrite.txt`, 'before')
    write(`${src}/_github_home/new.txt`, 'new')
    write(`${src}/_github_workflow/event.json`, '{}')
    write(`${src}/overwrite.txt`, 'after')
    write(`${src}/step.sh`, 'echo hi')

    runSh(mergeTempDirCommand(src, dst))

    expect(list(`${dst}/_github_home`)).toEqual(['new.txt', 'old.txt'])
    expect(fs.readFileSync(`${dst}/_github_workflow/event.json`, 'utf8')).toBe(
      '{}'
    )
    expect(fs.readFileSync(`${dst}/overwrite.txt`, 'utf8')).toBe('after')
    expect(fs.readFileSync(`${dst}/keep.sh`, 'utf8')).toBe('keep')
    expect(fs.readFileSync(`${dst}/step.sh`, 'utf8')).toBe('echo hi')
  })

  it('removes the staging dir and creates a missing destination', () => {
    write(`${src}/_runner_file_commands/set_output_new-step`, '')

    runSh(mergeTempDirCommand(src, dst))

    expect(fs.existsSync(src)).toBe(false)
    expect(list(`${dst}/_runner_file_commands`)).toEqual([
      'set_output_new-step'
    ])
  })

  it('handles paths that need quoting', () => {
    src = path.join(root, 'with space', '_temp_pre')
    dst = path.join(root, 'with space', '_temp')
    write(`${dst}/_runner_file_commands/set_output_old-step`, 'stale')
    write(`${src}/_runner_file_commands/set_output_new-step`, '')

    runSh(mergeTempDirCommand(src, dst))

    expect(list(`${dst}/_runner_file_commands`)).toEqual([
      'set_output_new-step'
    ])
  })
})

describe('clearStaleTempCommand', () => {
  it('removes _temp and _temp_pre but nothing else in the work dir', () => {
    write(`${root}/_temp/_runner_file_commands/set_output_a`)
    write(`${root}/_temp/_runner_file_commands/set_output_b`)
    write(`${root}/_temp/old-step.sh`)
    write(`${root}/_temp_pre/leftover.txt`)
    write(`${root}/repo/repo/source.c`, 'int main;')
    write(`${root}/.pv-metadata`, 'pv-1')

    const out = runSh(clearStaleTempCommand(root))

    expect(out.trim()).toBe(
      `Removed 4 stale file(s) left in ${root}/_temp by earlier jobs`
    )
    expect(list(root)).toEqual(['.pv-metadata', 'repo'])
    expect(fs.readFileSync(`${root}/repo/repo/source.c`, 'utf8')).toBe(
      'int main;'
    )
  })

  it('is a silent no-op on a fresh work dir', () => {
    write(`${root}/repo/repo/source.c`)

    const out = runSh(clearStaleTempCommand(root))

    expect(out).toBe('')
    expect(list(root)).toEqual(['repo'])
  })
})
