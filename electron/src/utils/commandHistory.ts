/**
 * Command history manager for tracking and navigating through executed commands.
 */

export class CommandHistory {
  private history: string[] = [];
  private currentIndex: number = -1;
  private maxSize: number;
  private temporaryCommand: string = '';

  constructor(maxSize: number = 100) {
    this.maxSize = maxSize;
  }

  /**
   * Add a command to the history.
   */
  add(command: string): void {
    if (!command.trim()) {
      return;
    }

    // Don't add duplicate consecutive commands
    if (this.history.length > 0 && this.history[this.history.length - 1] === command) {
      this.currentIndex = -1;
      return;
    }

    this.history.push(command);

    // Limit history size
    if (this.history.length > this.maxSize) {
      this.history.shift();
    }

    this.currentIndex = -1;
    this.temporaryCommand = '';
  }

  /**
   * Navigate backward in history (older commands).
   * Returns the previous command or null if at the beginning.
   */
  previous(currentCommand?: string): string | null {
    if (this.history.length === 0) {
      return null;
    }

    // Save current command when first navigating back
    if (this.currentIndex === -1 && currentCommand !== undefined) {
      this.temporaryCommand = currentCommand;
    }

    // Calculate new index
    if (this.currentIndex === -1) {
      this.currentIndex = this.history.length - 1;
    } else if (this.currentIndex > 0) {
      this.currentIndex--;
    }

    return this.history[this.currentIndex];
  }

  /**
   * Navigate forward in history (newer commands).
   * Returns the next command, temporary command, or null if at the end.
   */
  next(): string | null {
    if (this.currentIndex === -1) {
      return null;
    }

    this.currentIndex++;

    if (this.currentIndex >= this.history.length) {
      this.currentIndex = -1;
      const temp = this.temporaryCommand;
      this.temporaryCommand = '';
      return temp || null;
    }

    return this.history[this.currentIndex];
  }

  /**
   * Get all commands in history.
   */
  getAll(): string[] {
    return [...this.history];
  }

  /**
   * Clear all history.
   */
  clear(): void {
    this.history = [];
    this.currentIndex = -1;
    this.temporaryCommand = '';
  }

  /**
   * Get the current position in history (-1 means not navigating).
   */
  getCurrentIndex(): number {
    return this.currentIndex;
  }

  /**
   * Get the size of the history.
   */
  size(): number {
    return this.history.length;
  }

  /**
   * Search history for commands containing the given text.
   */
  search(query: string): string[] {
    if (!query) {
      return [...this.history];
    }

    return this.history.filter(cmd => cmd.includes(query));
  }
}
