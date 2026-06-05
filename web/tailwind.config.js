/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        snow: {
          blue: "#29B5E8",
          "blue-dark": "#1B9CD6",
          green: "#21BA45",
          red: "#FF4B4B",
          orange: "#FFA500",
        },
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
};
