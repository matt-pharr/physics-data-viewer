/**
 * session-idle.ts — decide when a session with nobody watching should stop.
 *
 * A daemon that outlives its client is the feature; a daemon that outlives
 * its usefulness is a process quietly holding a login node's memory against
 * a per-user cap. This policy is the difference.
 *
 * Three rules, each chosen because the obvious alternative loses work:
 *
 *  - **A brief disconnect is not a detach.** A reattach inside the grace
 *    window cancels the countdown entirely, so a flaky network or a lid
 *    closed for a minute is a lifecycle non-event rather than the start of a
 *    shutdown clock.
 *  - **The kernel cap counts idle time, not elapsed time.** A literal
 *    reading — "shut down 12 hours after the client left" — would SIGKILL a
 *    20-hour simulation with the laptop shut, which is precisely the data
 *    loss this whole feature exists to prevent. The timer therefore starts
 *    when execution goes idle, and `capCountsExecution` restores the literal
 *    behaviour for anyone who wants it.
 *  - **A failed autosave blocks the shutdown.** Exiting after a failed
 *    autosave destroys exactly the work the autosave existed to protect, so
 *    the session stays up and retries instead.
 *
 * Clock and timers are injected, so the tests exercise twelve-hour
 * behaviour without waiting twelve hours.
 *
 * This module does NOT own the kernel or the socket; it asks the questions
 * and reports the verdict.
 */

/** No clients and no kernel: nothing to preserve. */
export const NO_KERNEL_IDLE_MS = 30 * 60 * 1000;

/** A reattach inside this window does not count as a detach at all. */
export const REATTACH_GRACE_MS = 90 * 1000;

/** Default ceiling on an idle kernel with no clients (12 hours). */
export const DEFAULT_IDLE_CAP_HOURS = 12;

/** Options for {@link SessionIdlePolicy}. */
export interface SessionIdlePolicyOptions {
  /** True while a kernel exists (idle or busy). */
  hasKernel: () => boolean;
  /** True while the kernel is executing. */
  isExecuting: () => boolean;
  /**
   * Persist the session before shutting down. Resolving false (or throwing)
   * blocks the shutdown and schedules a retry.
   */
  autosave: () => Promise<boolean>;
  /** Stop the session. Called only after a successful autosave. */
  shutdown: () => void;
  /** Hours an idle kernel may survive with no clients. 0 means forever. */
  idleCapHours?: number;
  /**
   * Count execution time against the cap (the literal reading). Defaults to
   * false, so the cap measures *idle* hours as its name says.
   */
  capCountsExecution?: boolean;
  /** No-kernel idle window. Defaults to {@link NO_KERNEL_IDLE_MS}. */
  noKernelIdleMs?: number;
  /** Reattach grace. Defaults to {@link REATTACH_GRACE_MS}. */
  reattachGraceMs?: number;
  /** How long to wait before retrying a failed autosave. */
  autosaveRetryMs?: number;
  /** Timer factory, injected by tests. */
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  /** Timer canceller, injected by tests. */
  clearTimer?: (handle: NodeJS.Timeout) => void;
}

/**
 * The idle policy for one session (see the file header).
 *
 * Drive it from the host: {@link onClientsGone} when the last client
 * detaches, {@link onClientAttached} when one arrives, and
 * {@link onExecutionIdle} / {@link onExecutionBusy} when the kernel stops
 * and starts executing.
 */
export class SessionIdlePolicy {
  private readonly opts: SessionIdlePolicyOptions;
  private readonly setTimer: (fn: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimer: (handle: NodeJS.Timeout) => void;
  private timer: NodeJS.Timeout | null = null;
  private clientsGone = false;
  private stopped = false;
  /**
   * True once the reattach grace window has elapsed with no client. The
   * execution-state hooks act only in this phase: during grace the grace
   * timer alone decides what happens next, so a kernel going idle ten
   * seconds after a disconnect cannot replace the 90-second grace timer
   * with a countdown.
   */
  private graceDone = false;

  /**
   * @param opts - Predicates, actions, and injectable timers.
   */
  constructor(opts: SessionIdlePolicyOptions) {
    this.opts = opts;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));
  }

  /**
   * Whether a shutdown is currently scheduled (diagnostics and tests).
   *
   * @returns True when a countdown is running.
   */
  get isCountingDown(): boolean {
    return this.timer !== null;
  }

  /**
   * The last client went away; start the appropriate countdown.
   *
   * @returns Nothing.
   */
  onClientsGone(): void {
    if (this.stopped) return;
    this.clientsGone = true;
    this.graceDone = false;
    // Grace first: a reconnect within the window cancels everything, so a
    // dropped VPN never even starts a shutdown clock.
    this.arm(this.opts.reattachGraceMs ?? REATTACH_GRACE_MS, () =>
      this.afterGrace(),
    );
  }

  /**
   * A client attached; cancel any countdown.
   *
   * @returns Nothing.
   */
  onClientAttached(): void {
    this.clientsGone = false;
    this.graceDone = false;
    this.disarm();
  }

  /**
   * The kernel stopped executing; start the cap now that it is truly idle.
   *
   * @returns Nothing.
   */
  onExecutionIdle(): void {
    if (this.stopped || !this.clientsGone || !this.graceDone) return;
    this.armCap();
  }

  /**
   * The kernel started executing; suspend the cap until it is idle again.
   *
   * Without this, work that *starts* after the cap was armed — a scheduled
   * callback, a computation kicked off just before the client detached —
   * would race the countdown, and the timer could fire mid-run. Under
   * `capCountsExecution` the clock deliberately keeps running (the literal
   * reading), so this is a no-op there.
   *
   * @returns Nothing.
   */
  onExecutionBusy(): void {
    if (this.stopped || !this.clientsGone || !this.graceDone) return;
    if (this.opts.capCountsExecution) return;
    // The cap re-arms from onExecutionIdle when the work finishes.
    this.disarm();
  }

  /**
   * Stop the policy; no further shutdowns will be scheduled.
   *
   * @returns Nothing.
   */
  dispose(): void {
    this.stopped = true;
    this.disarm();
  }

  /** After the grace window: decide which countdown applies. */
  private afterGrace(): void {
    this.graceDone = true;
    if (!this.opts.hasKernel()) {
      // Nothing to preserve, so no autosave is required to justify exiting.
      this.arm(this.opts.noKernelIdleMs ?? NO_KERNEL_IDLE_MS, () =>
        this.finish(),
      );
      return;
    }
    this.armCap();
  }

  /** Arm the kernel cap, unless execution should postpone it. */
  private armCap(): void {
    const hours = this.opts.idleCapHours ?? DEFAULT_IDLE_CAP_HOURS;
    if (hours <= 0) {
      this.disarm(); // 0 means never.
      return;
    }
    if (this.opts.isExecuting() && !this.opts.capCountsExecution) {
      // Long-running work with the laptop shut is the case this feature
      // exists for. The cap starts when execution ends (onExecutionIdle).
      this.disarm();
      return;
    }
    this.arm(hours * 60 * 60 * 1000, () => this.finish());
  }

  /** Autosave, then shut down — but only if the autosave succeeded. */
  private finish(): void {
    this.timer = null;
    if (this.opts.isExecuting() && !this.opts.capCountsExecution) {
      // The timer fired in the window before an execution-busy event could
      // disarm it. Killing running work is the loss this policy exists to
      // prevent; the cap re-arms from onExecutionIdle when the work ends.
      return;
    }
    void this.opts
      .autosave()
      .then((saved) => {
        if (this.stopped) return;
        if (!saved) {
          this.retryAutosave();
          return;
        }
        this.opts.shutdown();
      })
      .catch(() => {
        if (!this.stopped) this.retryAutosave();
      });
  }

  /** A failed autosave must never let the session exit. */
  private retryAutosave(): void {
    console.error(
      "[session-idle] autosave failed; staying alive and retrying rather " +
        "than exiting with unsaved work",
    );
    this.arm(this.opts.autosaveRetryMs ?? 5 * 60 * 1000, () => this.finish());
  }

  /** Replace any pending countdown. */
  private arm(ms: number, fn: () => void): void {
    this.disarm();
    this.timer = this.setTimer(fn, ms);
    this.timer.unref?.();
  }

  /** Cancel any pending countdown. */
  private disarm(): void {
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }
}
