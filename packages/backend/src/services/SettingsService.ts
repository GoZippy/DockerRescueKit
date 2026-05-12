import { Database } from '../db/Database'

export class SettingsService {
  constructor(private db: Database) {}

  public async getSetting(key: string, defaultValue?: string): Promise<string | undefined> {
    const val = await this.db.getSetting(key)
    return val !== null ? val : defaultValue
  }

  public async saveSetting(key: string, value: string): Promise<void> {
    await this.db.saveSetting(key, value)
  }

  public async getBooleanSetting(key: string, defaultValue: boolean = false): Promise<boolean> {
    const val = await this.getSetting(key)
    if (val === undefined) return defaultValue
    return val === 'true'
  }

  public async saveBooleanSetting(key: string, value: boolean): Promise<void> {
    await this.saveSetting(key, value ? 'true' : 'false')
  }
}
