// Assuming App.tsx is in the same directory or adjust path as needed
import App from './App'; 
import { AppProvider } from './contexts/AppContext';

// React 19 style imports for client rendering
import React from 'react'; // Import React from the npm package
import { createRoot } from 'react-dom/client'; // Import createRoot from the npm package

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = createRoot(rootElement);
root.render(
  <React.StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </React.StrictMode>
);
