import { DockerService } from './DockerService'
import { Database } from '../db/Database'
import { HealthCheckService } from './HealthCheckService'
import { logger } from '../utils/logger'
import { v4 as uuidv4 } from 'uuid'

/**
 * Classification categories for container log events
 */
export type LogCategory = 'oomkilled' | 'port_conflict' | 'permission_denied' | 'dns_failed' | 'healthcheck_failed' | 'other'

/**
 * Severity levels for detected events
 */
export type EventSeverity = 'error' | 'warning'

/**
 * A single triaged log event with categorization and fix suggestion
 */
export interface TriagedEvent {
  id: string
  containerId: string
  containerName: string
  image: string
  category: LogCategory
  severity: EventSeverity
  fullMessage: string  // Full matched log line (with timestamp)
  logSnippet: string   // First 200 chars for preview
  fixSuggestion: string
  detectedAt: string // ISO 8601
  exitCode?: number
}

/**
 * Response summary showing categorized events and statistics
 */
export interface TriageResponse {
  events: TriagedEvent[]
  fetchedLines: number
  categories: Record<LogCategory, number>
}

/**
 * Pattern matching configuration per category
 */
interface ErrorPattern {
  regex: RegExp
  severity: EventSeverity
  suggestion: string
}

/**
 * LogTriageService — parses container logs for known error patterns,
 * categorizes them, and persists results for historical analysis.
 */
export class LogTriageService {
  private readonly ERROR_PATTERNS: Record<LogCategory, ErrorPattern[]> = {
    oomkilled: [
      {
        regex: /memory\s+(pressure|limit|cgroup)/i,
        severity: 'error',
        suggestion: 'Increase container memory limit or reduce application heap size'
      },
      {
        regex: /killed:\s+exit\s+code\s+137/i,
        severity: 'error',
        suggestion: 'Container was killed by kernel (OOM). Increase memory limit in docker-compose or deployment config'
      },
      {
        regex: /out\s+of\s+memory/i,
        severity: 'error',
        suggestion: 'Application ran out of memory. Check heap settings or increase container --memory limit'
      }
    ],
    port_conflict: [
      {
        regex: /address\s+already\s+in\s+use/i,
        severity: 'error',
        suggestion: 'Another service is using this port. Change container port or stop the conflicting service'
      },
      {
        regex: /bind\s+failed.*port\s+\d+/i,
        severity: 'error',
        suggestion: 'Port binding failed. Ensure the port is available and not in use'
      },
      {
        regex: /port\s+\d+\s+is\s+already\s+in\s+use/i,
        severity: 'error',
        suggestion: 'Port is already in use. Change container port or stop conflicting service'
      },
      {
        regex: /address\s+in\s+use/i,
        severity: 'error',
        suggestion: 'Cannot bind to address/port. Check if service is already running'
      }
    ],
    permission_denied: [
      {
        regex: /permission\s+denied/i,
        severity: 'error',
        suggestion: 'File or directory permission denied. Check Docker user permissions or volume mount ownership'
      },
      {
        regex: /permission\s+error/i,
        severity: 'error',
        suggestion: 'Permission error encountered. Verify user permissions inside container'
      },
      {
        regex: /eacces/i,
        severity: 'error',
        suggestion: 'Permission denied (EACCES). Fix file permissions or container user'
      },
      {
        regex: /cannot\s+execute/i,
        severity: 'error',
        suggestion: 'Cannot execute binary. Check file permissions and ensure binary exists'
      }
    ],
    dns_failed: [
      {
        regex: /name\s+or\s+service\s+not\s+known/i,
        severity: 'error',
        suggestion: 'DNS resolution failed. Check container DNS settings or network connectivity'
      },
      {
        regex: /getaddrinfo\s+(failed|error)/i,
        severity: 'error',
        suggestion: 'DNS lookup failed. Verify DNS server and domain name'
      },
      {
        regex: /failed\s+to\s+resolve/i,
        severity: 'error',
        suggestion: 'Failed to resolve hostname. Check DNS configuration and network connectivity'
      },
      {
        regex: /nxdomain/i,
        severity: 'error',
        suggestion: 'Domain does not exist (NXDOMAIN). Verify hostname spelling'
      },
      {
        regex: /dns\s+resolution\s+failed/i,
        severity: 'error',
        suggestion: 'DNS resolution failed. Check DNS server and network settings'
      }
    ],
    healthcheck_failed: [
      {
        regex: /healthcheck\s+(failed|error)/i,
        severity: 'error',
        suggestion: 'Container healthcheck failed. Review container logs for startup errors'
      },
      {
        regex: /health\s+check\s+timed\s+out/i,
        severity: 'error',
        suggestion: 'Healthcheck timed out. Application may be unresponsive or slow to start'
      },
      {
        regex: /unsuccessful\s+health\s+check/i,
        severity: 'error',
        suggestion: 'Health probe unsuccessful. Verify service is running and responding'
      }
    ],
    other: []
  }

  constructor(
    private docker: DockerService,
    private db: Database,
    private health?: HealthCheckService
  ) {}

  /**
   * Classify log events for a single container
   * @param containerId Container ID or name
   * @param limit Maximum log lines to fetch (default 100)
   * @param categoryFilter Optional category to filter results
   * @returns Array of triaged events with categorization
   */
  public async classifyEvents(containerId: string, limit: number = 100, categoryFilter?: string): Promise<TriageResponse> {
    try {
      // Validate and fetch container
      const containers = await this.docker.listContainers()
      const container = containers.find(c => c.Id.includes(containerId) || c.Names?.some(n => n.includes(containerId)))

      if (!container) {
        throw new Error(`Container not found: ${containerId}`)
      }

      const actualId = container.Id
      const containerName = container.Names?.[0]?.replace(/^\//, '') || 'unknown'
      const image = container.Image || 'unknown'

      // Fetch logs with streaming and demux
      let logLines: string[] = []
      try {
        logLines = await this.fetchContainerLogs(actualId, limit)
      } catch (err: any) {
        // Gracefully handle permission errors
        if (err.code === 'EACCES' || err.code === 'EPERM') {
          logger.warn(`Cannot read logs for ${containerName}: permission denied`)
          return {
            events: [],
            fetchedLines: 0,
            categories: this.getEmptyCategories()
          }
        }
        throw err
      }

      // Classify events from logs
      let events = this.parseLogsForEvents(actualId, containerName, image, logLines)

      // Apply category filter if requested
      if (categoryFilter) {
        events = events.filter(e => e.category === categoryFilter)
      }

      // Persist to database
      for (const event of events) {
        await this.db.insertLogEvent(event)
      }

      // Return categorized summary
      const categories = this.countCategories(events)
      return {
        events,
        fetchedLines: logLines.length,
        categories
      }
    } catch (err) {
      logger.error({ err, containerId }, 'Error classifying events')
      throw err
    }
  }

  /**
   * Background job to scan all broken containers
   */
  public async scanAllContainers(): Promise<void> {
    try {
      const containers = await this.docker.listContainers()

      // Filter to likely-broken containers: exited, restarting, or unhealthy
      const brokenContainers = containers.filter(c => {
        const state = c.State?.toLowerCase()
        return state === 'exited' || state === 'restarting' || c.Status?.includes('unhealthy')
      })

      logger.info(`Scanning ${brokenContainers.length} broken containers for log patterns`)

      // Scan each in sequence to avoid overwhelming Docker daemon
      for (const container of brokenContainers) {
        try {
          await this.classifyEvents(container.Id, 500) // Scan last 500 lines
        } catch (err) {
          logger.warn({ err, containerName: container.Names?.[0] }, 'Failed to scan container')
          // Continue with next container
        }
      }

      logger.info('Container log scan complete')
    } catch (err) {
      logger.error({ err }, 'Error scanning all containers')
      throw err
    }
  }

  /**
   * Fetch container logs via Docker API with streaming
   * Timeout set to 10 seconds per container to avoid hanging
   * Demuxes stdout/stderr to handle timestamped multistream output correctly
   */
  private async fetchContainerLogs(containerId: string, limit: number): Promise<string[]> {
    return new Promise((resolve, reject) => {
      let stream: any = null
      const timeout = setTimeout(() => {
        if (stream) {
          stream.destroy()
        }
        reject(new Error(`Log fetch timeout for ${containerId}`))
      }, 10000)

      try {
        // Use DockerService's internal docker client to respect socket configuration
        const dockerClient = (this.docker as any).docker || this.docker
        const container = dockerClient.getContainer(containerId)

        // Request demuxed output (separate stdout/stderr streams)
        container.logs({
          stdout: true,
          stderr: true,
          timestamps: true,
          demux: true,
          tail: limit,
          follow: false
        }, (err: any, outputStream: any) => {
          if (err) {
            clearTimeout(timeout)
            return reject(err)
          }

          if (!outputStream) {
            clearTimeout(timeout)
            return reject(new Error('No stream returned from container.logs()'))
          }

          stream = outputStream
          let output = ''

          stream.on('data', (chunk: Buffer) => {
            output += chunk.toString('utf8')
          })

          stream.on('end', () => {
            clearTimeout(timeout)
            const lines = output
              .split('\n')
              .filter(line => line.trim().length > 0)
            resolve(lines)
          })

          stream.on('error', (err: Error) => {
            clearTimeout(timeout)
            reject(err)
          })
        })
      } catch (err) {
        clearTimeout(timeout)
        reject(err)
      }
    })
  }

  /**
   * Parse log lines and classify by error patterns
   *
   * Deduplication Strategy:
   * - Prevents the same regex pattern from matching multiple lines in a single log dump
   * - Each pattern is tracked per-dump (seenPatterns Set is local to this call)
   * - Different categories with different patterns will all be emitted
   * - This avoids redundant events like "OOM killed" matching both line 5 and line 12
   */
  private parseLogsForEvents(
    containerId: string,
    containerName: string,
    image: string,
    logLines: string[]
  ): TriagedEvent[] {
    const events: TriagedEvent[] = []
    const seenPatterns = new Set<string>()

    for (const line of logLines) {
      // Try each category in order of priority
      for (const category of Object.keys(this.ERROR_PATTERNS) as LogCategory[]) {
        if (category === 'other') continue

        const patterns = this.ERROR_PATTERNS[category]
        for (const pattern of patterns) {
          if (pattern.regex.test(line)) {
            const patternKey = `${category}:${pattern.regex.source}`

            // Avoid duplicate events for same pattern in same log dump
            if (seenPatterns.has(patternKey)) continue
            seenPatterns.add(patternKey)

            events.push({
              id: uuidv4(),
              containerId,
              containerName,
              image,
              category,
              severity: pattern.severity,
              fullMessage: line, // Full line with timestamp
              logSnippet: line.substring(0, 200), // First 200 chars for preview
              fixSuggestion: pattern.suggestion,
              detectedAt: new Date().toISOString(),
              exitCode: this.extractExitCode(line)
            })

            // Only emit first match per category per line
            break
          }
        }
      }
    }

    return events
  }

  /**
   * Extract exit code from log line if present (best-effort)
   *
   * Note: Most containers don't log "exit code" in their output.
   * This extraction will succeed only if the container explicitly logged the exit code.
   * Exit codes are more reliably obtained via Docker API (container.inspect().State.ExitCode),
   * but that requires separate API calls per container. This is a lightweight fallback
   * for log analysis when the log dump happens to include it.
   */
  private extractExitCode(line: string): number | undefined {
    const match = /exit\s+code\s+(\d+)/i.exec(line) || /exited\s+with\s+code\s+(\d+)/i.exec(line)
    return match ? parseInt(match[1], 10) : undefined
  }

  /**
   * Count events by category
   */
  private countCategories(events: TriagedEvent[]): Record<LogCategory, number> {
    const counts = this.getEmptyCategories()
    for (const event of events) {
      counts[event.category]++
    }
    return counts
  }

  /**
   * Initialize empty category counts
   */
  private getEmptyCategories(): Record<LogCategory, number> {
    return {
      oomkilled: 0,
      port_conflict: 0,
      permission_denied: 0,
      dns_failed: 0,
      healthcheck_failed: 0,
      other: 0
    }
  }
}
