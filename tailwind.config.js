/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
    "./contexts/**/*.{js,ts,jsx,tsx}",
    "./App.tsx",
    "./index.tsx"
  ],
  darkMode: 'class', // Enable class-based dark mode
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
      },
      colors: {
        brand: {
          primary: '#EF4444',     // Red 500 (Matches Logout/Error - "EzyPrint Red")
          primaryDark: '#DC2626', // Red 600
          secondary: '#FFFFFF',   // White
          secondaryLight: '#F8FAFC', // Slate 50
          accent: '#18181B',       // Zinc 900
          text: '#18181B',       // Zinc 900 (Deep Black)
          lightText: '#71717A',   // Zinc 500
          muted: '#E4E4E7',     // Zinc 200
          bg: '#FAFAFA',         // Zinc 50

          // Dark Mode Specific Colors
          dark: {
            bg: '#0F172A',        // Slate 900 (Returning to Slate for better standard dark mode)
            surface: '#1E293B',   // Slate 800
            surfaceHighlight: '#334155', // Slate 700
            text: '#F8FAFC',      // Slate 50 (White for clear visibility)
            textSecondary: '#94A3B8', // Slate 400
            border: '#334155',    // Slate 700
          }
        },
        status: {
          success: '#10B981',  // Emerald 500
          warning: '#F59E0B',  // Amber 500
          error: '#EF4444',    // Red 500
          info: '#3B82F6',     // Blue 500
          pending: '#F97316',  // Orange 500
        }
      },
      boxShadow: {
        'card': '0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03)', // Softer shadow
        'modal': '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
        'glow': '0 0 20px rgba(79, 70, 229, 0.15)', // Indigo glow
      },
      borderRadius: {
        'xl': '1rem',
        '2xl': '1.5rem',
        '3xl': '2rem', // More rounded for "fresh" look
      },
      animation: {
        'fade-in': 'fadeIn 0.5s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        }
      }
    },
  },
  plugins: [],
}
