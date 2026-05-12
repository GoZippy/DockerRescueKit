import axios, { AxiosInstance } from 'axios'

export interface CliConfig {
  baseURL: string
  apiKey: string
}

export function resolveConfig(): CliConfig {
  const baseURL = process.env.DRK_URL || 'http://localhost:42880'
  const apiKey = process.env.DRK_API_KEY || process.env.API_KEY || ''
  if (!apiKey) {
    throw new Error(
      'DRK_API_KEY (or API_KEY) must be set. Find it in the backend logs on first run, or check $DRK_DATA_DIR/secrets.json.'
    )
  }
  return { baseURL, apiKey }
}

export function createClient(cfg: CliConfig = resolveConfig()): AxiosInstance {
  return axios.create({
    baseURL: cfg.baseURL + '/api',
    headers: {
      'x-api-key': cfg.apiKey,
      'Content-Type': 'application/json'
    },
    timeout: 60_000
  })
}
