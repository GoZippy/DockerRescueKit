import path from 'path'
import os from 'os'
import { safeJoin, safeFilenameFragment } from '../utils/PathSafety'

describe('safeJoin', () => {
  const base = path.join(os.tmpdir(), 'drk-safejoin')

  it('joins a simple relative path', () => {
    expect(safeJoin(base, 'a', 'b.txt')).toBe(path.resolve(base, 'a', 'b.txt'))
  })

  it('rejects parent-dir traversal', () => {
    expect(() => safeJoin(base, '../escape.txt')).toThrow(/escape/i)
  })

  it('rejects absolute-path sneak attempts', () => {
    expect(() => safeJoin(base, path.resolve('/etc/passwd'))).toThrow(/escape/i)
  })
})

describe('safeFilenameFragment', () => {
  it('keeps safe characters', () => {
    expect(safeFilenameFragment('Backup-1.2_3')).toBe('Backup-1.2_3')
  })

  it('replaces unsafe characters', () => {
    expect(safeFilenameFragment('a/b\\c:d*e')).toBe('a_b_c_d_e')
  })

  it('caps length at 128', () => {
    expect(safeFilenameFragment('x'.repeat(300)).length).toBe(128)
  })
})
