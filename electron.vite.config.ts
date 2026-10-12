import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

// Nada é resolvido em tempo de execução a partir de node_modules: o processo
// principal só usa módulos embutidos do Node e do Electron, e o renderer é
// empacotado inteiro. Por isso todas as dependências ficam em devDependencies.
export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react()],
  },
});
