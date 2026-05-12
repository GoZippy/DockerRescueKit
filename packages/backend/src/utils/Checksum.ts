import crypto from 'crypto'
import fs from 'fs'

export async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(path)
    stream.on('data', (c) => hash.update(c))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}
