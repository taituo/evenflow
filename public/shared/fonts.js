// Font families (system stacks — no downloads, works offline).
export const FONTS = {
  display: { label: 'Display', stack: '"SF Pro Display", "Inter", "Segoe UI Variable Display", system-ui, -apple-system, sans-serif' },
  sans: { label: 'Sans', stack: 'Arial, Helvetica, sans-serif' },
  serif: { label: 'Serif', stack: '"New York", Georgia, "Times New Roman", serif' },
  mono: { label: 'Mono', stack: '"SF Mono", ui-monospace, Menlo, Consolas, "Liberation Mono", monospace' },
  rounded: { label: 'Rounded', stack: 'ui-rounded, "SF Pro Rounded", "Nunito", "Varela Round", system-ui, sans-serif' },
  condensed: { label: 'Condensed', stack: '"Arial Narrow", "Roboto Condensed", "Helvetica Neue Condensed", sans-serif-condensed, sans-serif' },
  geometric: { label: 'Geometric', stack: '"Avenir Next", "Futura", "Century Gothic", "Montserrat", system-ui, sans-serif' },
  hand: { label: 'Handwritten', stack: '"Bradley Hand", "Segoe Print", "Comic Neue", "Chalkboard SE", cursive' },
};
export const fontStack = (key) => (FONTS[key] ? FONTS[key].stack : FONTS.sans.stack);
