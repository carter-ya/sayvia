import { defineContentScript } from 'wxt/utils/define-content-script';
import { installYouTubeCapture } from '../src/captions/capture-main';
export default defineContentScript({
  registration: 'runtime',
  world: 'MAIN',
  main() {
    installYouTubeCapture();
  },
});
