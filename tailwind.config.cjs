/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        mint: {
          50: "#effcf5",
          100: "#d9f7e7",
          500: "#2fbf71",
          600: "#23a35f",
        },
        tangerine: {
          50: "#fff6ee",
          100: "#ffe6cf",
          500: "#ff8a3d",
          600: "#f46e1f",
        },
      },
      boxShadow: {
        soft: "0 8px 24px rgba(17, 24, 39, 0.08)",
      },
      keyframes: {
        "demo-step-in": {
          "0%": { opacity: "0", transform: "translate(6px, 10px)" },
          "100%": { opacity: "1", transform: "translate(0, 0)" },
        },
      },
      animation: {
        "demo-step-in": "demo-step-in 0.4s cubic-bezier(0.22, 1, 0.36, 1) both",
      },
    },
  },
  plugins: [],
};
