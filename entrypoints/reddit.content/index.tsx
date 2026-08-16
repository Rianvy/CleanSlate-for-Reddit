import { createShadowRootUi, defineContentScript } from '#imports';
import ReactDOM from 'react-dom/client';
import { CleanerApp } from '../../src/CleanerApp';
import './style.css';

export default defineContentScript({
  matches: ['https://*.reddit.com/*'],
  cssInjectionMode: 'ui',
  async main(ctx) {
    const ui = await createShadowRootUi(ctx, {
      name: 'cleanslate-for-reddit',
      position: 'overlay',
      anchor: 'body',
      isolateEvents: true,
      onMount(container) {
        const app = document.createElement('div');
        container.append(app);
        const root = ReactDOM.createRoot(app);
        root.render(<CleanerApp />);
        return root;
      },
      onRemove(root) {
        root?.unmount();
      },
    });
    ui.mount();
  },
});
