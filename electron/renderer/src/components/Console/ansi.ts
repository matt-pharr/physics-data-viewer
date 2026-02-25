/**
 * ansi.ts — ANSI escape sequence processing for console output.
 *
 * Two responsibilities:
 *  1. Simulate terminal cursor-movement / line-erase controls so that
 *     pip-style animated progress bars collapse to their final visible state.
 *  2. Convert surviving ANSI color/style codes to HTML via ansi-to-html.
 *
 * Does NOT handle: scrolling regions, alternate screen buffer, multi-line
 * cursor movement beyond [A (up). Those sequences are simply stripped.
 */

import AnsiToHtml from "ansi-to-html";

const converter = new AnsiToHtml({
  fg: "var(--text-primary)",
  bg: "transparent",
  escapeXML: true,
  stream: false,
  colors: {
    // Map 256-color palette entries used by pip/rich to reasonable values.
    // ansi-to-html fills the rest automatically from the standard palette.
  },
});

/**
 * Apply terminal line-level control sequences to produce the final visible
 * text, preserving ANSI color codes for the second pass.
 *
 * Handles:
 *  - `\r`        carriage return  → overwrite from column 0
 *  - `[2K`       erase entire line
 *  - `[K` / `[0K` erase to end of line (treated as erase whole line here)
 *  - `[nA`       cursor up n lines
 *  - `[?25l/h`   cursor hide/show  → stripped
 *  - `[nF`       cursor to start of n lines up (pip uses this)
 *  - Other CSI   passed through (colour codes)
 */
function applyTerminalControls(input: string): string {
  const lines: string[] = [""];
  let row = 0;
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (ch === "\r" && input[i + 1] === "\n") {
      // Windows CRLF — treat as newline
      row++;
      if (row >= lines.length) lines.push("");
      i += 2;
      continue;
    }

    if (ch === "\n") {
      row++;
      if (row >= lines.length) lines.push("");
      i++;
      continue;
    }

    if (ch === "\r") {
      // Carriage return: clear from column 0 and stay on same row
      lines[row] = "";
      i++;
      continue;
    }

    if (ch === "\x1b" && input[i + 1] === "[") {
      // CSI — collect parameter bytes and the final command byte
      i += 2;
      let params = "";
      while (
        i < input.length &&
        (input[i] === "?" ||
          input[i] === ";" ||
          (input[i] >= "0" && input[i] <= "9"))
      ) {
        params += input[i++];
      }
      const cmd = input[i] ?? "";
      i++;

      if (cmd === "K") {
        // Erase line — any variant: clear the whole current line
        lines[row] = "";
      } else if (cmd === "A") {
        // Cursor up n lines
        const n = parseInt(params, 10) || 1;
        row = Math.max(0, row - n);
      } else if (cmd === "F") {
        // Cursor to start of line, n lines up
        const n = parseInt(params, 10) || 1;
        row = Math.max(0, row - n);
        lines[row] = "";
      } else if (cmd === "J") {
        // Erase in display — strip, too complex to simulate faithfully
      } else if (cmd === "h" || cmd === "l") {
        // Private mode (cursor visibility, etc.) — strip
      } else {
        // Colour / style codes — pass through for ansi-to-html
        lines[row] += `\x1b[${params}${cmd}`;
      }
      continue;
    }

    // Ordinary character — strip lone ESC bytes that aren't CSI sequences
    if (ch === "\x1b") {
      i++;
      continue;
    }

    lines[row] += ch;
    i++;
  }

  return lines.join("\n");
}

/**
 * Convert a raw terminal output string (with ANSI escape sequences) to an
 * HTML string safe for use with `dangerouslySetInnerHTML`.
 *
 * @param raw - Raw stdout/stderr text from the kernel.
 * @returns HTML string with colour spans and no raw escape codes.
 */
export function ansiToHtml(raw: string): string {
  const processed = applyTerminalControls(raw);
  try {
    return converter.toHtml(processed);
  } catch {
    // Fall back to escaped plain text if conversion fails
    return processed.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}
