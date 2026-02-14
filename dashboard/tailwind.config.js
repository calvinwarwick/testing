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
      },
      fontFamily: {
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      borderColor: {
        /* Very subtle: barely visible dark grey, no white/contrasting borders */
        subtle: "#0d0d0d",
      },
    },
  },
  plugins: [],
};
