/** @type {import('tailwindcss').Config} */
export default {
  // Includes the root ledger-prototype-v3.jsx so Tailwind keeps the utility
  // classes the app actually uses (they'd be purged otherwise).
  content: ["./index.html", "./src/**/*.{js,jsx}", "./ledger-prototype-v3.jsx"],
  theme: {
    extend: {},
  },
  plugins: [],
};
