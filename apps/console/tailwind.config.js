/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        mas: {
          50: "#f5f7fa",
          100: "#e5e9f0",
          200: "#c8d1de",
          300: "#a3b1c6",
          400: "#7a8aa5",
          500: "#5b6c87",
          600: "#475772",
          700: "#3a4760",
          800: "#2e3a4f",
          900: "#1f2738",
        },
      },
    },
  },
  plugins: [],
};
