import si from 'systeminformation'

export class TelemetryService {
  public async getStats() {
    try {
      const [cpu, mem, load, uptime, fs, net, os] = await Promise.all([
        si.cpu(),
        si.mem(),
        si.currentLoad(),
        si.time(),
        si.fsSize(),
        si.networkStats(),
        si.osInfo()
      ])

      return {
        cpu: {
          manufacturer: cpu.manufacturer,
          brand: cpu.brand,
          cores: cpu.cores,
          loadPercent: Math.round(load.currentLoad)
        },
        memory: {
          total: mem.total,
          free: mem.free,
          used: mem.used,
          active: mem.active,
          available: mem.available,
          percent: Math.round((mem.active / mem.total) * 100)
        },
        storage: fs.map(f => ({
          fs: f.fs,
          type: f.type,
          size: f.size,
          used: f.used,
          available: f.available,
          usePercent: f.use,
          mount: f.mount
        })),
        network: net.map(n => ({
          iface: n.iface,
          operstate: n.operstate,
          rx_sec: n.rx_sec,
          tx_sec: n.tx_sec,
          rx_bytes: n.rx_bytes,
          tx_bytes: n.tx_bytes
        })),
        os: {
          platform: os.platform,
          distro: os.distro,
          release: os.release,
          kernel: os.kernel,
          arch: os.arch,
          hostname: os.hostname
        },
        uptime: uptime.uptime,
        timestamp: new Date()
      }
    } catch (err) {
      console.error('Failed to fetch telemetry:', err)
      return null
    }
  }
}
