import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

const isDevelopment = process.env.NODE_ENV === 'development';

export default defineConfig({
  define: {
    __EXCALIDRAW_URL__: JSON.stringify(process.env.EXCALIDRAW_URL ?? 'https://excalidraw.com'),
    __EXCALIDRAW_EXPORT_ENABLED__: process.env.EXCALIDRAW_EXPORT_ENABLED === 'true',
    __EXCALIDRAW_SAVE_FILE_ENABLED__: process.env.EXCALIDRAW_SAVE_FILE_ENABLED !== 'false',
    __EXCALIDRAW_FULLSCREEN_ENABLED__: process.env.EXCALIDRAW_FULLSCREEN_ENABLED === 'true',
  },
  plugins: [react(), viteSingleFile()],
  build: {
    sourcemap: isDevelopment ? 'inline' : undefined,
    cssMinify: !isDevelopment,
    minify: !isDevelopment,

    rollupOptions: {
      input: path.resolve(__dirname, 'src/mcp-app.html'),
      external: [
        'react',
        'react-dom',
        'react-dom/client',
        'react/jsx-runtime',
        '@excalidraw/excalidraw',
        'morphdom',
      ],
      output: {
        paths: {
          react: 'https://esm.sh/react@19.0.0',
          'react-dom': 'https://esm.sh/react-dom@19.0.0?deps=react@19.0.0',
          'react-dom/client': 'https://esm.sh/react-dom@19.0.0/client?deps=react@19.0.0',
          'react/jsx-runtime': 'https://esm.sh/react@19.0.0/jsx-runtime',
          '@excalidraw/excalidraw':
            'https://esm.sh/@excalidraw/excalidraw@0.18.0?deps=react@19.0.0,react-dom@19.0.0',
          morphdom: 'https://esm.sh/morphdom@2.7.8',
        },
      },
    },
    outDir: 'dist',
    emptyOutDir: false,
  },
});
