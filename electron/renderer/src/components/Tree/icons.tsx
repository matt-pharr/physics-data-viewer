/**
 * icons.tsx — SVG icons for the Tree panel's type column.
 *
 * One component per node kind in `pdv-protocol.ts`'s `NodeKindValue`,
 * plus the synthetic `root` and `unknown` fallbacks. All icons use
 * `fill="currentColor"` so they recolor with the surrounding text.
 * Internal detail (play triangle on script, prose lines on note,
 * etc.) is rendered as cutouts via `fill-rule="evenodd"`, so a single
 * fill rule does the whole icon — no theme-color references inside.
 *
 * Display size is set in `tree.css` via `.tree-icon { width/height }`,
 * not on the components themselves.
 */

import React from 'react';

type IconProps = React.SVGProps<SVGSVGElement>;

const defaults: IconProps = {
  width: 20,
  height: 20,
  viewBox: '0 0 20 20',
  fill: 'currentColor',
};

// ---------------------------------------------------------------------------
// Synthetic / structural
// ---------------------------------------------------------------------------

/** Tree-panel root row (`pdv_tree`). Three nodes wired in a hierarchy. */
export const RootIcon: React.FC<IconProps> = (props) => (
  <svg {...defaults} {...props}>
    <circle cx="10" cy="4" r="2.5" />
    <circle cx="5" cy="16" r="2.5" />
    <circle cx="15" cy="16" r="2.5" />
    <path d="M9.25 6 H10.75 V10.5 H15.75 V13.5 H14.25 V12 H5.75 V13.5 H4.25 V10.5 H9.25 Z" />
  </svg>
);

/** Fallback when type detection failed. Filled circle with `?` cutout. */
export const UnknownIcon: React.FC<IconProps> = (props) => (
  <svg {...defaults} {...props}>
    <path
      fillRule="evenodd"
      d="M10 3 a7 7 0 1 1 0 14 a7 7 0 1 1 0 -14 Z M10 6 q2.5 0 2.5 2 0 1.6 -1.5 2.5 -.6 .4 -.6 1.1 V12 H9.4 v -0.6 q0 -1.2 1.1 -1.7 1.1 -.6 1.1 -1.4 0 -1.1 -1.6 -1.1 -1.6 0 -1.6 1.6 H6.9 Q6.9 6 10 6 Z M10 13.4 a0.7 0.7 0 1 1 0 1.4 a0.7 0.7 0 1 1 0 -1.4 Z"
    />
  </svg>
);

// ---------------------------------------------------------------------------
// Containers (branches)
// ---------------------------------------------------------------------------

/** Explicit PDV folder. Classic tab-folder silhouette. */
export const FolderIcon: React.FC<IconProps> = (props) => (
  <svg {...defaults} {...props}>
    <path d="M3 7 H5 V5 H9 V7 H17 V16 H3 Z" />
  </svg>
);

/** Plain Python `dict`. Pair of filled curly braces. Stroke is 2 units in
 *  the straight portions, narrowing to 1 unit at the pinch — closer to
 *  typographic norms than a uniform-thickness brace. */
export const MappingIcon: React.FC<IconProps> = (props) => (
  <svg {...defaults} {...props}>
    <path d="M8 3 Q5 3 5 5 V8 Q5 10 3 10 Q5 10 5 12 V15 Q5 17 8 17 V16 Q7 16 7 15 V12 Q7 10 4 10 Q7 10 7 8 V5 Q7 4 8 4 Z" />
    <path d="M12 3 Q15 3 15 5 V8 Q15 10 17 10 Q15 10 15 12 V15 Q15 17 12 17 V16 Q13 16 13 15 V12 Q13 10 16 10 Q13 10 13 8 V5 Q13 4 12 4 Z" />
  </svg>
);

/** `list` / `tuple` / `set` / `frozenset`. Pair of filled square brackets. */
export const SequenceIcon: React.FC<IconProps> = (props) => (
  <svg {...defaults} {...props}>
    <path d="M7 4 H4 V16 H7 V15 H5 V5 H7 Z" />
    <path d="M13 4 H16 V16 H13 V15 H15 V5 H13 Z" />
  </svg>
);

// ---------------------------------------------------------------------------
// Built-in data leaves
// ---------------------------------------------------------------------------

/** `int` / `float` / `bool` / `complex` / `None`. Number-sign glyph. */
export const ScalarIcon: React.FC<IconProps> = (props) => (
  <svg {...defaults} {...props}>
    <path d="M6 3 H8 V17 H6 Z M12 3 H14 V17 H12 Z M3 7 H17 V9 H3 Z M3 11 H17 V13 H3 Z" />
  </svg>
);

/** `str`. Capital `T` glyph. */
export const TextIcon: React.FC<IconProps> = (props) => (
  <svg {...defaults} {...props}>
    <path d="M3 4 H17 V7 H12 V17 H8 V7 H3 Z" />
  </svg>
);

/** `bytes` / `bytearray`. Just the `01` glyph rendered in the system
 *  monospace font — letting font hinting handle the numeral shapes is
 *  more legible at 16px than any path-drawn approximation. */
export const BinaryIcon: React.FC<IconProps> = (props) => (
  <svg {...defaults} {...props}>
    <text
      x="10"
      y="15"
      textAnchor="middle"
      fontFamily="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
      fontSize="14"
      fontWeight="700"
    >
      01
    </text>
  </svg>
);

/** NumPy `ndarray`. 3×3 grid of filled cells. */
export const NdarrayIcon: React.FC<IconProps> = (props) => (
  <svg {...defaults} {...props}>
    <rect x="3" y="3" width="4" height="4" rx="0.5" />
    <rect x="8" y="3" width="4" height="4" rx="0.5" />
    <rect x="13" y="3" width="4" height="4" rx="0.5" />
    <rect x="3" y="8" width="4" height="4" rx="0.5" />
    <rect x="8" y="8" width="4" height="4" rx="0.5" />
    <rect x="13" y="8" width="4" height="4" rx="0.5" />
    <rect x="3" y="13" width="4" height="4" rx="0.5" />
    <rect x="8" y="13" width="4" height="4" rx="0.5" />
    <rect x="13" y="13" width="4" height="4" rx="0.5" />
  </svg>
);

/** pandas `DataFrame`. Header bar plus 2×3 grid of cells. */
export const DataframeIcon: React.FC<IconProps> = (props) => (
  <svg {...defaults} {...props}>
    <rect x="3" y="4" width="14" height="3.5" rx="0.5" />
    <rect x="3" y="9" width="3.7" height="3" rx="0.3" />
    <rect x="8.15" y="9" width="3.7" height="3" rx="0.3" />
    <rect x="13.3" y="9" width="3.7" height="3" rx="0.3" />
    <rect x="3" y="13.5" width="3.7" height="3" rx="0.3" />
    <rect x="8.15" y="13.5" width="3.7" height="3" rx="0.3" />
    <rect x="13.3" y="13.5" width="3.7" height="3" rx="0.3" />
  </svg>
);

/** pandas `Series`. Single column of three filled cells. */
export const SeriesIcon: React.FC<IconProps> = (props) => (
  <svg {...defaults} {...props}>
    <rect x="6" y="3.5" width="8" height="3.7" rx="0.3" />
    <rect x="6" y="8.15" width="8" height="3.7" rx="0.3" />
    <rect x="6" y="12.8" width="8" height="3.7" rx="0.3" />
  </svg>
);

// ---------------------------------------------------------------------------
// PDV file-backed concepts (shared "document with corner fold" silhouette)
// ---------------------------------------------------------------------------

/** Generic `PDVFile`. Filled document silhouette with corner cut. */
export const FileIcon: React.FC<IconProps> = (props) => (
  <svg {...defaults} {...props}>
    <path d="M5 3 H13 L17 7 V17 H5 Z" />
  </svg>
);

/** `PDVScript`. Document with play-triangle cutout. */
export const ScriptIcon: React.FC<IconProps> = (props) => (
  <svg {...defaults} {...props}>
    <path
      fillRule="evenodd"
      d="M5 3 H13 L17 7 V17 H5 Z M9 9.5 L14 12.5 L9 15.5 Z"
    />
  </svg>
);

/** `PDVNote`. Document with three prose lines as cutouts. */
export const MarkdownIcon: React.FC<IconProps> = (props) => (
  <svg {...defaults} {...props}>
    <path
      fillRule="evenodd"
      d="M5 3 H13 L17 7 V17 H5 Z M7 9.5 H14 V10.7 H7 Z M7 12 H14 V13.2 H7 Z M7 14.5 H11 V15.7 H7 Z"
    />
  </svg>
);

/** `PDVNamelist`. Document with `key=value` row cutouts. */
export const NamelistIcon: React.FC<IconProps> = (props) => (
  <svg {...defaults} {...props}>
    <path
      fillRule="evenodd"
      d="M5 3 H13 L17 7 V17 H5 Z M7 9.5 H9 V10.7 H7 Z M11 9.5 H14 V10.7 H11 Z M7 12 H9 V13.2 H7 Z M11 12 H14 V13.2 H11 Z M7 14.5 H9 V15.7 H7 Z M11 14.5 H13.5 V15.7 H11 Z"
    />
  </svg>
);

/** `PDVGui`. Document with window cutout (titlebar visible). */
export const GuiIcon: React.FC<IconProps> = (props) => (
  <svg {...defaults} {...props}>
    <path
      fillRule="evenodd"
      d="M5 3 H13 L17 7 V17 H5 Z M7 11 H14 V16 H7 Z M7 11 H14 V12 H7 Z"
    />
  </svg>
);

// ---------------------------------------------------------------------------
// PDV concepts that aren't single files
// ---------------------------------------------------------------------------

/** `PDVLib`. Three book spines on a shelf, varying heights. */
export const LibIcon: React.FC<IconProps> = (props) => (
  <svg {...defaults} {...props}>
    <rect x="4" y="5" width="3" height="12" rx="0.5" />
    <rect x="8" y="3" width="3" height="14" rx="0.5" />
    <rect x="12" y="6" width="3" height="11" rx="0.5" />
  </svg>
);

/** `PDVModule`. Isometric cube with shaded faces. Body height roughly
 *  matches top-edge length, so the silhouette reads as a cube rather
 *  than a flat hexagonal disc. */
export const ModuleIcon: React.FC<IconProps> = (props) => (
  <svg {...defaults} {...props}>
    <path opacity="0.45" d="M10 2 L17 6 L10 10 L3 6 Z" />
    <path opacity="0.7" d="M17 6 L17 14 L10 18 L10 10 Z" />
    <path d="M3 6 L3 14 L10 18 L10 10 Z" />
  </svg>
);

// ---------------------------------------------------------------------------
// Type-keyed lookup
// ---------------------------------------------------------------------------

/**
 * Map a wire-protocol node kind (or the synthetic `root`) to its icon
 * component. Anything not in this map renders {@link UnknownIcon}.
 */
export const TYPE_ICONS: Record<string, React.FC<IconProps>> = {
  root: RootIcon,
  folder: FolderIcon,
  mapping: MappingIcon,
  sequence: SequenceIcon,
  scalar: ScalarIcon,
  text: TextIcon,
  binary: BinaryIcon,
  ndarray: NdarrayIcon,
  dataframe: DataframeIcon,
  series: SeriesIcon,
  file: FileIcon,
  script: ScriptIcon,
  markdown: MarkdownIcon,
  namelist: NamelistIcon,
  gui: GuiIcon,
  lib: LibIcon,
  module: ModuleIcon,
  unknown: UnknownIcon,
};
