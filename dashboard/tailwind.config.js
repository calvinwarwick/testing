/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          dark: "#0a0a0a",
          panel: "#111111",
          card: "#18181b",
        },
        positive: "#22c55e",
        negative: "#ef4444",
        open: "#eab308",
        muted: "#a1a1aa",
        /* Very dark grey for section titles, borders and dividers (visible on #111 panel) */
        edge: "#2d2d2d",
      },
      fontFamily: {
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      borderColor: {
        subtle: "#0d0d0d",
        edge: "#2d2d2d",
      },
    },
  },
  plugins: [],
};
